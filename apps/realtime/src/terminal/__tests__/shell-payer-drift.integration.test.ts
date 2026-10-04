/**
 * A terminal session whose DRIVE MOVES while the PTY is open (Spec WAL-9) — real Postgres, the
 * real heartbeat settle (`settleAccruedWindow`), the real sandbox billing deps.
 *
 * The session's charge used to be fixed when it opened. A drive that moved into an org left the
 * open session billing the PERSON for the org drive's compute until the PTY ended (and a PTY can
 * stay attached indefinitely); a drive that moved out left the ORG paying for a personal drive.
 * Hold and settle sat on the same wallet, so the mismatch guard never fired.
 *
 * The rule now, asserted to the millicent: every window is settled on the payer it OPENED under
 * (the tail belongs to whoever owed it, on the hold that payer's wallet carried); at the window
 * boundary the payer is re-read, and the next window is held and settled on the new one. The
 * boundary is the heartbeat (10 minutes), so a move is noticed within one heartbeat and the
 * window it fell in stays with the payer it opened under.
 *
 * Requires DATABASE_URL → a migrated Postgres. Every row it creates is deleted.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, getAdvisoryLockPool, pool as dbPool } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { defaultSandboxBillingDeps } from '@pagespace/lib/services/sandbox/sandbox-billing';
import { computeChargeFor, type ComputeCharge } from '@pagespace/lib/billing/compute-charge';
import { chargeMillicents } from '@pagespace/lib/billing/credit-core';
import { MACHINE_MARKUP_BPS } from '@pagespace/lib/billing/credit-pricing';
import { calculateMachineCostDollars } from '@pagespace/lib/monitoring/machine-pricing';
import { claimBillingWindow, settleAccruedWindow } from '../shell-handler';
import { pgWindowClaimLock, windowClaimLockKey } from '../window-claim-lock';
import { withBlockingAdvisoryLock } from '@pagespace/db/advisory-lock';
import { DEFAULT_SEAT_ALLOWANCE_CENTS } from '@pagespace/lib/billing/wallet-core';
import type { TerminalSession, TerminalSessionMap } from '../terminal-session-map';

const originalMode = process.env.DEPLOYMENT_MODE;
let dbAvailable = false;

const MIN = 60_000;
const T0 = new Date('2026-09-28T10:00:00.000Z').getTime();
/** The millicents one window of `seconds` settles for: the sandbox machine rate at the terminal markup, one rounding, as trackUsage does. */
const windowMc = (seconds: number) => chargeMillicents(calculateMachineCostDollars({ activeSeconds: seconds }), MACHINE_MARKUP_BPS);

interface World {
  ownerId: string;
  leadId: string;
  orgId: string;
  driveId: string;
  poolId: string;
  ownerWalletId: string;
  leadWalletId: string;
  userIds: string[];
}
let world: World | null = null;

async function personalWallet(userId: string): Promise<string> {
  const [w] = await db.insert(wallets).values({
    userId,
    monthlyRemainingCents: 10_000,
    monthlyAllowanceCents: 10_000,
    monthlyPeriodStart: new Date(),
    monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
  }).returning();
  return w.id;
}

/** A solo owner with a PERSONAL drive, an org (funded pool) whose lead owns a separate org drive. */
async function build(start: 'personal' | 'org'): Promise<World> {
  const owner = await factories.createUser({ name: 'Priya (session owner)', subscriptionTier: 'pro' });
  const lead = await factories.createUser({ name: 'Jono (lead)', subscriptionTier: 'pro' });
  const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: lead.id }).returning();
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: lead.id, role: 'OWNER' },
    { orgId: org.id, userId: owner.id, role: 'MEMBER' },
  ]);
  const drive = start === 'org'
    ? await factories.createDrive(lead.id, { name: 'Product', slug: `product-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' })
    : await factories.createDrive(owner.id, { name: 'Solo', slug: `solo-${createId()}` });
  const [pool] = await db.insert(wallets).values({ ownerType: 'org', orgId: org.id, monthlyRemainingCents: 10_000 }).returning();
  return {
    ownerId: owner.id,
    leadId: lead.id,
    orgId: org.id,
    driveId: drive.id,
    poolId: pool.id,
    ownerWalletId: await personalWallet(owner.id),
    leadWalletId: await personalWallet(lead.id),
    userIds: [owner.id, lead.id],
  };
}

async function teardown(w: World): Promise<void> {
  await db.delete(aiUsageLogs).where(inArray(aiUsageLogs.userId, w.userIds));
  await db.delete(creditHolds).where(inArray(creditHolds.userId, w.userIds));
  await db.delete(creditLedger).where(inArray(creditLedger.userId, w.userIds));
  await db.delete(wallets).where(eq(wallets.id, w.poolId));
  await db.delete(wallets).where(inArray(wallets.userId, w.userIds));
  await db.delete(drives).where(eq(drives.id, w.driveId));
  await db.delete(orgMembers).where(eq(orgMembers.orgId, w.orgId));
  await db.delete(organizations).where(eq(organizations.id, w.orgId));
  await db.delete(users).where(inArray(users.id, w.userIds));
}

const usageOn = async (walletId: string) =>
  (await db.select().from(creditLedger).where(eq(creditLedger.walletId, walletId)))
    .filter((r) => r.entryType === 'usage')
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
/** Millicents that actually left a wallet since it was funded with 10,000 cents: whole cents drawn plus the sub-cent carry it grew by. */
async function drawnMc(walletId: string): Promise<number> {
  const [w] = await db.select().from(wallets).where(eq(wallets.id, walletId));
  return (10_000 - w.monthlyRemainingCents) * 1000 + w.pendingMillicents + w.debtCents * 1000;
}
const holdsOn = (walletId: string) => db.select().from(creditHolds).where(eq(creditHolds.walletId, walletId));

/** An OPEN session (PTY attached, billing armed) on the real deps, opened at T0 on `charge` with a real hold. */
async function openSession(w: World, charge: ComputeCharge): Promise<{ session: TerminalSession; map: TerminalSessionMap }> {
  const gate = await defaultSandboxBillingDeps.gate({ charge });
  if (!gate.allowed) throw new Error(`gate refused: ${gate.reason}`);
  const session = {
    sessionKey: 'k1',
    charge,
    ownerId: w.ownerId,
    actorId: w.ownerId,
    holdId: gate.holdId,
    connectedAt: T0,
    driveId: w.driveId,
    workspaceId: `ws-${createId()}`,
  } as unknown as TerminalSession;
  const map = { getByKey: (key: string) => (key === 'k1' ? session : undefined) } as unknown as TerminalSessionMap;
  return { session, map };
}

/** One heartbeat at `at`: the real settle of the window since the last boundary. */
async function heartbeat(at: number, map: TerminalSessionMap, session: TerminalSession): Promise<boolean> {
  vi.setSystemTime(at);
  return settleAccruedWindow(defaultSandboxBillingDeps, map, session, 'k1');
}

beforeAll(async () => {
  try {
    await db.select({ id: wallets.id }).from(wallets).limit(1);
    dbAvailable = true;
  } catch (error) {
    requireDb('shell-payer-drift.integration.test.ts', error);
  }
});

beforeEach(() => {
  process.env.DEPLOYMENT_MODE = 'cloud';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterAll(async () => {
  await getAdvisoryLockPool().end();
  await dbPool.end();
});

afterEach(async () => {
  vi.useRealTimers();
  process.env.DEPLOYMENT_MODE = originalMode;
  if (dbAvailable && world) await teardown(world);
  world = null;
});

describe('an open terminal session whose drive moves', () => {
  it('WAL-9 (partial) INTO an org: the window the move fell in stays with the PERSON who owed it, everything after lands on the ORG POOL, to the millicent', async () => {
    const w = (world = await build('personal'));
    const { session, map } = await openSession(w, computeChargeFor({ kind: 'user', userId: w.ownerId }, w.ownerId));

    // 10:00-10:30: a quiet half hour on the person's own drive. Two heartbeats' worth is one window here.
    expect(await heartbeat(T0 + 30 * MIN, map, session)).toBe(true);
    expect(session.charge).toEqual({ kind: 'user', userId: w.ownerId });

    // 10:35 the drive moves into the org while the PTY stays attached.
    await db.update(drives).set({ orgId: w.orgId }).where(eq(drives.id, w.driveId));

    // 10:40 the heartbeat: the 10:30-10:40 window is settled on the person (the payer it opened under),
    // the payer is re-read, and the NEXT window is held on the org pool.
    expect(await heartbeat(T0 + 40 * MIN, map, session)).toBe(true);
    expect(session.charge).toEqual({ kind: 'org', orgId: w.orgId, userId: w.ownerId });
    expect((await holdsOn(w.poolId)).length).toBe(1);
    expect(await holdsOn(w.ownerWalletId)).toEqual([]);

    // 11:00 the next heartbeat: 10:40-11:00 is the org's.
    expect(await heartbeat(T0 + 60 * MIN, map, session)).toBe(true);

    const person = await usageOn(w.ownerWalletId);
    const pool = await usageOn(w.poolId);
    expect(person.map((r) => r.chargeMillicents)).toEqual([windowMc(1800), windowMc(600)]);
    expect(pool.map((r) => r.chargeMillicents)).toEqual([windowMc(1200)]);
    expect(pool[0]).toMatchObject({ userId: w.ownerId, spendKind: 'compute', consumeStatus: 'applied' });
    // And the BALANCES moved by exactly those amounts: the person's by the two windows it owed, the pool's by the one it owed.
    expect(await drawnMc(w.ownerWalletId)).toBe(windowMc(1800) + windowMc(600));
    expect(await drawnMc(w.poolId)).toBe(windowMc(1200));
    // Nothing of the org's window touched the person, nothing of the person's touched the pool, and the lead is uninvolved.
    expect(person.every((r) => r.spendKind === 'compute')).toBe(true);
    expect(await usageOn(w.leadWalletId)).toEqual([]);
    // The hold on the pool is the NEXT window's reservation, released or settled by the next boundary: exactly one, on the pool.
    expect((await holdsOn(w.poolId)).length).toBe(1);
    expect(await holdsOn(w.ownerWalletId)).toEqual([]);
  });

  it('WAL-9 (partial) OUT of an org: the window the move fell in stays with the ORG POOL that owed it, everything after lands on the drive owner, to the millicent', async () => {
    const w = (world = await build('org'));
    // The session owner is the person running it; the drive's org pool pays while it is an org drive.
    const { session, map } = await openSession(w, { kind: 'org', orgId: w.orgId, userId: w.ownerId });

    expect(await heartbeat(T0 + 30 * MIN, map, session)).toBe(true);
    expect(session.charge).toMatchObject({ kind: 'org', orgId: w.orgId });

    await db.update(drives).set({ orgId: null }).where(eq(drives.id, w.driveId));

    expect(await heartbeat(T0 + 40 * MIN, map, session)).toBe(true);
    // After the move the drive is personal again: its payer is the drive's owner (the lead who created it).
    expect(session.charge).toEqual({ kind: 'user', userId: w.leadId });
    expect(await holdsOn(w.poolId)).toEqual([]);
    expect((await holdsOn(w.leadWalletId)).length).toBe(1);

    expect(await heartbeat(T0 + 60 * MIN, map, session)).toBe(true);

    expect((await usageOn(w.poolId)).map((r) => r.chargeMillicents)).toEqual([windowMc(1800), windowMc(600)]);
    expect((await usageOn(w.leadWalletId)).map((r) => r.chargeMillicents)).toEqual([windowMc(1200)]);
    expect(await usageOn(w.ownerWalletId)).toEqual([]);
    expect(await drawnMc(w.poolId)).toBe(windowMc(1800) + windowMc(600));
    expect(await drawnMc(w.leadWalletId)).toBe(windowMc(1200));
    expect(await drawnMc(w.ownerWalletId)).toBe(0);
  });

  it('a drive that does not move bills one payer throughout: the re-read changes nothing', async () => {
    const w = (world = await build('personal'));
    const { session, map } = await openSession(w, computeChargeFor({ kind: 'user', userId: w.ownerId }, w.ownerId));

    await heartbeat(T0 + 10 * MIN, map, session);
    await heartbeat(T0 + 20 * MIN, map, session);

    expect((await usageOn(w.ownerWalletId)).map((r) => r.chargeMillicents)).toEqual([windowMc(600), windowMc(600)]);
    expect(await usageOn(w.poolId)).toEqual([]);
    expect(session.charge).toEqual({ kind: 'user', userId: w.ownerId });
  });
});

/**
 * Review #2760 P1: a live PTY is shared with the drive's members, so the person who joins it runs
 * compute in it. The window moves to them — gated first against THEIR OWN cap — and the window so
 * far stays with the actor who opened it. The session's owner is never who a joiner's compute is
 * capped against.
 */
describe('a member joining a live terminal window', () => {
  async function addBen(w: World, capped: boolean): Promise<string> {
    const ben = await factories.createUser({ name: 'Ben (drive-mate)', subscriptionTier: 'free' });
    w.userIds.push(ben.id);
    await db.insert(orgMembers).values({ orgId: w.orgId, userId: ben.id, role: 'MEMBER' });
    if (capped) {
      const cents = DEFAULT_SEAT_ALLOWANCE_CENTS;
      await db.insert(creditLedger).values({ userId: ben.id, walletId: w.poolId, entryType: 'usage', bucket: 'monthly', amountCents: -cents, appliedCents: -cents, chargeMillicents: cents * 1000, consumeStatus: 'applied', spendKind: 'ai' });
    }
    return ben.id;
  }
  const ledgerOf = async (userId: string) => (await db.select().from(creditLedger).where(eq(creditLedger.userId, userId))).filter((r) => r.entryType === 'usage' && r.spendKind === 'compute');

  it('WAL-2 (partial) terminal: Ben, at his cap, typing into Priya\'s live PTY is refused with the cap message — the window stays Priya\'s, untouched, and nothing is charged to anyone', async () => {
    const w = (world = await build('org'));
    const benId = await addBen(w, true);
    const { session, map } = await openSession(w, computeChargeFor({ kind: 'org', orgId: w.orgId }, w.ownerId));
    const before = { charge: session.charge, holdId: session.holdId, connectedAt: session.connectedAt, actorId: session.actorId };

    vi.setSystemTime(T0 + 3 * MIN);
    const claim = await claimBillingWindow(defaultSandboxBillingDeps, map, session, benId);

    expect(claim).toMatchObject({ ok: false, message: expect.stringMatching(/used your allowance/) });
    expect({ charge: session.charge, holdId: session.holdId, connectedAt: session.connectedAt, actorId: session.actorId }).toEqual(before);
    expect(await db.select().from(creditHolds).where(eq(creditHolds.userId, benId))).toEqual([]);
    expect(await ledgerOf(w.ownerId)).toEqual([]);
    expect(await ledgerOf(benId)).toEqual([]);
  });

  it('WAL-2 (partial) terminal: Ben, under his cap, typing takes the window — Priya pays exactly the window she opened, Ben holds and pays from then on', async () => {
    const w = (world = await build('org'));
    const benId = await addBen(w, false);
    const { session, map } = await openSession(w, computeChargeFor({ kind: 'org', orgId: w.orgId }, w.ownerId));

    vi.setSystemTime(T0 + 3 * MIN);
    expect(await claimBillingWindow(defaultSandboxBillingDeps, map, session, benId)).toEqual({ ok: true });

    // Priya's 3-minute window settled to her; the next window is Ben's, held on the pool under him.
    const priya = await ledgerOf(w.ownerId);
    expect(priya.map((r) => r.chargeMillicents)).toEqual([windowMc(180)]);
    expect(session.charge).toEqual({ kind: 'org', orgId: w.orgId, userId: benId });
    expect(session.actorId).toBe(benId);
    expect((await db.select().from(creditHolds).where(eq(creditHolds.userId, benId))).map((h) => [h.walletId, h.spendKind])).toEqual([[w.poolId, 'compute']]);

    // The next heartbeat settles Ben's 5 minutes to Ben, never to Priya.
    expect(await heartbeat(T0 + 8 * MIN, map, session)).toBe(true);
    expect((await ledgerOf(benId)).map((r) => r.chargeMillicents)).toEqual([windowMc(300)]);
    expect(await ledgerOf(w.ownerId)).toHaveLength(1);
  });
});

describe('two typists claiming one live PTY at the same instant (re-review P2-1)', () => {
  async function addMember(w: World, name: string): Promise<string> {
    const user = await factories.createUser({ name, subscriptionTier: 'free' });
    w.userIds.push(user.id);
    await db.insert(orgMembers).values({ orgId: w.orgId, userId: user.id, role: 'MEMBER' });
    return user.id;
  }
  const usageOf = async (userId: string) =>
    (await db.select().from(creditLedger).where(eq(creditLedger.userId, userId))).filter((r) => r.entryType === 'usage' && r.spendKind === 'compute');
  const holdsOf = async (userIds: string[]) => db.select().from(creditHolds).where(inArray(creditHolds.userId, userIds));

  it('WAL-2 (partial) B and C claim A\'s window together, each on its own connection: they take it IN TURN — no leaked hold, each window settled once, each segment charged to its typist', async () => {
    const w = (world = await build('org'));
    const [benId, chloeId] = [await addMember(w, 'Ben'), await addMember(w, 'Chloe')];
    const { session, map } = await openSession(w, computeChargeFor({ kind: 'org', orgId: w.orgId }, w.ownerId));

    vi.setSystemTime(T0 + 3 * MIN);
    const [rb, rc] = await Promise.all([
      claimBillingWindow(defaultSandboxBillingDeps, map, session, benId, pgWindowClaimLock),
      claimBillingWindow(defaultSandboxBillingDeps, map, session, chloeId, pgWindowClaimLock),
    ]);

    // Both claims ran, one after the other: neither reports success for a window it does not hold.
    expect([rb, rc]).toEqual([{ ok: true }, { ok: true }]);
    const last = session.actorId;
    const first = last === benId ? chloeId : benId;
    expect([benId, chloeId]).toContain(last);

    // Exactly ONE live hold — the window's own, under its actor. Nothing orphaned.
    const holds = await holdsOf([w.ownerId, benId, chloeId]);
    expect(holds.map((h) => [h.id, h.userId])).toEqual([[session.holdId, last]]);

    // A's window settled exactly once, to A; the first claimant's (instant) window exactly once, to
    // them; the last claimant's is still open and has settled nothing.
    expect((await usageOf(w.ownerId)).map((r) => r.chargeMillicents)).toEqual([windowMc(180)]);
    expect(await usageOf(first)).toHaveLength(1);
    expect(await usageOf(last)).toEqual([]);

    // The next heartbeat settles the open window to the person typing in it.
    expect(await heartbeat(T0 + 8 * MIN, map, session)).toBe(true);
    expect((await usageOf(last)).map((r) => r.chargeMillicents)).toEqual([windowMc(300)]);
    expect(await usageOf(w.ownerId)).toHaveLength(1);
  });

  it('the lock is real Postgres and BOUNDED: a claim waiting on another connection\'s lock gives up at the timeout without running', async () => {
    vi.useRealTimers();
    const holder = await getAdvisoryLockPool().connect();
    try {
      await holder.query('SELECT pg_advisory_lock(hashtext($1))', [windowClaimLockKey('k-held')]);
      const fn = vi.fn(async () => 'ran');
      const started = Date.now();
      expect(await withBlockingAdvisoryLock(getAdvisoryLockPool(), windowClaimLockKey('k-held'), fn, { timeoutMs: 200 })).toEqual({ outcome: 'lock_busy' });
      expect(fn).not.toHaveBeenCalled();
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [windowClaimLockKey('k-held')]);
      holder.release();
    }
  });
});

