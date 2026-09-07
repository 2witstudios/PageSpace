/**
 * The two dev-preview stores against a REAL Postgres — the properties that
 * only the database can prove:
 *
 *  - the holder-keyed UPSERT replaces a holder's row (a rebuild mints a new
 *    instance id, so the instance index never collides; only the partial
 *    unique index on the holder makes "re-create replaces" true), and the
 *    write clears `stoppedByUserAt`;
 *  - a grant is redeemable EXACTLY once, including under a concurrent race,
 *    and never after its expiry.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { sessions } from '@pagespace/db/schema/sessions';
import { drives } from '@pagespace/db/schema/core';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { devPreviewServices } from '@pagespace/db/schema/dev-preview-services';
import { devPreviewGrants } from '@pagespace/db/schema/dev-preview-grants';
import { createDbDevPreviewStore } from '../dev-preview-store';
import { createDbDevPreviewGrantsStore } from '../dev-preview-grants-store';
import { PREVIEW_COOKIE_TTL_MS, PREVIEW_GRANT_TTL_MS } from '../preview-grant';
import { PREVIEW_RELAY_SERVICE_NAME } from '../preview-relay';

const userId = createId();
const driveId = createId();
const envId = createId();
const sessionId = createId();
const NOW = new Date('2026-09-06T12:00:00.000Z');

beforeAll(async () => {
  await db.insert(users).values({ id: userId, email: `${userId}@example.com`, name: 'preview-store-test' });
  await db.insert(drives).values({ id: driveId, name: 'd', slug: `d-${driveId}`, ownerId: userId });
  await db.insert(driveEnvs).values({ id: envId, driveId, name: 'main', storageLastBilledAt: NOW });
  // A grant names the SESSION that opened it, so an integration test needs a
  // real one: the FK is what makes revocation reach the grants table.
  await db.insert(sessions).values({
    id: sessionId, tokenHash: `h-${sessionId}`, tokenPrefix: 'ps_', userId, type: 'user',
    tokenVersion: 1, expiresAt: new Date(NOW.getTime() + 86_400_000),
  });
});

afterAll(async () => {
  await db.delete(devPreviewGrants).where(eq(devPreviewGrants.userId, userId));
  await db.delete(sessions).where(eq(sessions.id, sessionId));
  await db.delete(driveEnvs).where(eq(driveEnvs.id, envId));
  await db.delete(drives).where(eq(drives.id, driveId));
  await db.delete(users).where(inArray(users.id, [userId]));
});

describe('createDbDevPreviewStore', () => {
  const store = createDbDevPreviewStore();
  const holder = { kind: 'env', id: envId } as const;

  it('upserts by holder: a re-create on a new instance REPLACES the holder row and clears the stop intent', async () => {
    await store.upsert({ holder, spriteInstanceId: 'inst-a', sandboxId: 'sbx', targetPort: 5173, relayServiceName: PREVIEW_RELAY_SERVICE_NAME, detectedAt: NOW, stoppedByUserAt: null, basedOnStoppedByUserAt: null });
    // Simulate the user switching it off on the old instance.
    await db.update(devPreviewServices).set({ stoppedByUserAt: NOW }).where(eq(devPreviewServices.envId, envId));
    const before = await store.findByHolder(holder);
    expect(before?.stoppedByUserAt).toEqual(NOW);

    await store.upsert({ holder, spriteInstanceId: 'inst-b', sandboxId: 'sbx', targetPort: 3000, relayServiceName: PREVIEW_RELAY_SERVICE_NAME, detectedAt: NOW, stoppedByUserAt: null, basedOnStoppedByUserAt: null });
    const rows = await db.select().from(devPreviewServices).where(eq(devPreviewServices.envId, envId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ spriteInstanceId: 'inst-b', targetPort: 3000, stoppedByUserAt: null, workspaceId: null });

    const after = await store.findByHolder(holder);
    expect(after).toMatchObject({ id: rows[0].id, spriteInstanceId: 'inst-b', sandboxId: 'sbx', targetPort: 3000, relayServiceName: PREVIEW_RELAY_SERVICE_NAME, stoppedByUserAt: null });
  });

  it('THE INTENT GUARD: a write planned before a user\'s stop is refused on the SAME instance (the click survives), while a re-create on a NEW instance replaces the row and the dead VM\'s stop with it', async () => {
    await store.upsert({ holder, spriteInstanceId: 'inst-guard', sandboxId: 'sbx', targetPort: 5173, relayServiceName: PREVIEW_RELAY_SERVICE_NAME, detectedAt: NOW, stoppedByUserAt: null, basedOnStoppedByUserAt: null });
    const stoppedAt = new Date('2026-09-06T13:00:00.000Z');
    await store.setStoppedByUser(holder, stoppedAt);

    // A detection frame that read the row BEFORE the stop (guard: null) must
    // not clear it — the write is refused and the row is untouched.
    const refused = await store.upsert({ holder, spriteInstanceId: 'inst-guard', sandboxId: 'sbx', targetPort: 3000, relayServiceName: PREVIEW_RELAY_SERVICE_NAME, detectedAt: NOW, stoppedByUserAt: null, basedOnStoppedByUserAt: null });
    expect(refused).toBe(false);
    expect(await store.findByHolder(holder)).toMatchObject({ targetPort: 5173, stoppedByUserAt: stoppedAt });

    // A frame that DID see the stop (guard: that timestamp) writes normally.
    const accepted = await store.upsert({ holder, spriteInstanceId: 'inst-guard', sandboxId: 'sbx', targetPort: 3000, relayServiceName: PREVIEW_RELAY_SERVICE_NAME, detectedAt: NOW, stoppedByUserAt: null, basedOnStoppedByUserAt: stoppedAt });
    expect(accepted).toBe(true);
    expect(await store.findByHolder(holder)).toMatchObject({ targetPort: 3000, stoppedByUserAt: null });

    // A REBUILD: the stored row names a dead instance, so its stop dies with
    // the VM and the re-create replaces it even with a null guard.
    await store.setStoppedByUser(holder, stoppedAt);
    const recreated = await store.upsert({ holder, spriteInstanceId: 'inst-rebuilt', sandboxId: 'sbx', targetPort: 5173, relayServiceName: PREVIEW_RELAY_SERVICE_NAME, detectedAt: NOW, stoppedByUserAt: null, basedOnStoppedByUserAt: null });
    expect(recreated).toBe(true);
    expect(await store.findByHolder(holder)).toMatchObject({ spriteInstanceId: 'inst-rebuilt', targetPort: 5173, stoppedByUserAt: null });
  });

  it('a direct (8080) row carries no relay name, as the CHECK requires', async () => {
    await store.upsert({ holder, spriteInstanceId: 'inst-c', sandboxId: 'sbx', targetPort: 8080, relayServiceName: null, detectedAt: NOW, stoppedByUserAt: null, basedOnStoppedByUserAt: null });
    expect(await store.findByHolder(holder)).toMatchObject({ targetPort: 8080, relayServiceName: null });
  });

  it('an UNSHARED unlisted port is a legal row — a non-8080 target with no relay, which serves nothing', async () => {
    // The old CHECK made this shape illegal, which is why it had to be
    // relaxed: consent has to be recordable before the relay exists.
    await store.upsert({ holder, spriteInstanceId: 'inst-u', sandboxId: 'sbx', targetPort: 9000, relayServiceName: null, detectedAt: NOW, stoppedByUserAt: null, basedOnStoppedByUserAt: null });
    expect(await store.findByHolder(holder)).toMatchObject({ targetPort: 9000, relayServiceName: null, approvedPort: null });
    // A relay pointed at 8080 would be a loop, and that half of the CHECK stands.
    await expect(
      db.insert(devPreviewServices).values({ envId: createId(), spriteInstanceId: createId(), sandboxId: 'sbx', targetPort: 8080, relayServiceName: PREVIEW_RELAY_SERVICE_NAME, detectedAt: NOW, updatedAt: NOW }),
    ).rejects.toThrow();
  });

  it('approvePort records consent for exactly the port shown, clears the stop, and REFUSES a port the row no longer targets', async () => {
    await store.upsert({ holder, spriteInstanceId: 'inst-ap', sandboxId: 'sbx', targetPort: 9000, relayServiceName: null, detectedAt: NOW, stoppedByUserAt: null, basedOnStoppedByUserAt: null });
    await store.setStoppedByUser(holder, NOW);

    const at = new Date('2026-09-06T12:45:00.000Z');
    expect(await store.approvePort(holder, { port: 9001, at, byUserId: userId })).toBeNull();
    expect((await store.findByHolder(holder))?.approvedPort).toBeNull();

    const approved = await store.approvePort(holder, { port: 9000, at, byUserId: userId });
    expect(approved).toMatchObject({ targetPort: 9000, approvedPort: 9000, stoppedByUserAt: null });
    const [stored] = await db.select().from(devPreviewServices).where(eq(devPreviewServices.envId, envId));
    expect(stored).toMatchObject({ approvedPort: 9000, approvedAt: at, approvedByUserId: userId });

    // A later detection carries the approval and its ORIGINAL timestamp
    // forward: the planner never grants or revokes, so nothing is restamped.
    await store.upsert({ holder, spriteInstanceId: 'inst-ap', sandboxId: 'sbx', targetPort: 9000, relayServiceName: PREVIEW_RELAY_SERVICE_NAME, detectedAt: new Date(NOW.getTime() + 60_000), stoppedByUserAt: null, basedOnStoppedByUserAt: null });
    const [after] = await db.select().from(devPreviewServices).where(eq(devPreviewServices.envId, envId));
    expect(after).toMatchObject({ approvedPort: 9000, approvedAt: at });

    // And a REBUILD carries nothing: a new instance replaces the row wholesale.
    await store.upsert({ holder, spriteInstanceId: 'inst-new', sandboxId: 'sbx', targetPort: 9000, relayServiceName: null, detectedAt: NOW, stoppedByUserAt: null, basedOnStoppedByUserAt: null });
    const [rebuilt] = await db.select().from(devPreviewServices).where(eq(devPreviewServices.envId, envId));
    expect(rebuilt).toMatchObject({ approvedPort: null, approvedAt: null });
    expect(await store.approvePort({ kind: 'workspace', id: createId() }, { port: 9000, at, byUserId: userId })).toBeNull();
  });

  it('findStoppedWithRelay lists ONLY aged rows that are switched off with a relay still recorded', async () => {
    // `updatedAt` is stamped by the DATABASE (`now() at time zone 'utc'`), so
    // the age window has to be measured against the real clock, not the fixed
    // NOW the rest of these fixtures use. This is also what proves the
    // comparison lands in the same time base the column is written in.
    const ask = () => store.findStoppedWithRelay({ staleAfterMs: 2 * 60 * 1000, limit: 50, now: new Date(Date.now() + 10 * 60 * 1000) });

    // Switched off with a relay: a candidate, but only once it has aged.
    await store.upsert({ holder, spriteInstanceId: 'inst-s', sandboxId: 'sbx', targetPort: 5173, relayServiceName: PREVIEW_RELAY_SERVICE_NAME, detectedAt: NOW, stoppedByUserAt: null, basedOnStoppedByUserAt: null });
    await store.setStoppedByUser(holder, NOW);
    // Not yet aged: the row was written a moment ago.
    expect(await store.findStoppedWithRelay({ staleAfterMs: 2 * 60 * 1000, limit: 50, now: new Date() })).toEqual([]);
    expect(await ask()).toEqual([{ holder: { kind: 'env', id: envId }, sandboxId: 'sbx' }]);

    // Resumed: no longer a candidate.
    await store.setStoppedByUser(holder, null);
    expect(await ask()).toEqual([]);

    // Switched off but with no relay recorded: nothing to stop.
    await store.upsert({ holder, spriteInstanceId: 'inst-s2', sandboxId: 'sbx', targetPort: 9000, relayServiceName: null, detectedAt: NOW, stoppedByUserAt: null, basedOnStoppedByUserAt: null });
    await store.setStoppedByUser(holder, NOW);
    expect(await ask()).toEqual([]);
  });

  it('markSwept re-stamps updatedAt and NOTHING else, which is what takes a converged row out of the sweep window', async () => {
    await store.upsert({ holder, spriteInstanceId: 'inst-sw', sandboxId: 'sbx', targetPort: 5173, relayServiceName: PREVIEW_RELAY_SERVICE_NAME, detectedAt: NOW, stoppedByUserAt: null, basedOnStoppedByUserAt: null });
    await store.setStoppedByUser(holder, NOW);
    const before = await store.findByHolder(holder);
    const stale = () => store.findStoppedWithRelay({ staleAfterMs: 0, limit: 50, now: new Date(Date.now() + 60_000) });
    expect(await stale()).toHaveLength(1);

    await store.markSwept(holder);
    // The row itself is untouched — the stop intent, the target and the relay
    // name are facts a sweep does not get to change.
    expect(await store.findByHolder(holder)).toEqual(before);
    // But it has left the window it was in.
    expect(await store.findStoppedWithRelay({ staleAfterMs: 60_000, limit: 50, now: new Date() })).toEqual([]);
  });

  it('answers null for a holder with no row', async () => {
    expect(await store.findByHolder({ kind: 'workspace', id: createId() })).toBeNull();
  });

  it('setStoppedByUser writes ONLY the intent column and returns the row as written, clears it on null, and answers null for a holder with no row', async () => {
    await store.upsert({ holder, spriteInstanceId: 'inst-d', sandboxId: 'sbx', targetPort: 5173, relayServiceName: PREVIEW_RELAY_SERVICE_NAME, detectedAt: NOW, stoppedByUserAt: null, basedOnStoppedByUserAt: null });
    const stoppedAt = new Date('2026-09-06T12:30:00.000Z');
    const written = await store.setStoppedByUser(holder, stoppedAt);
    expect(written).toMatchObject({ spriteInstanceId: 'inst-d', targetPort: 5173, relayServiceName: PREVIEW_RELAY_SERVICE_NAME, stoppedByUserAt: stoppedAt });
    expect(await store.findByHolder(holder)).toEqual(written);
    expect((await store.setStoppedByUser(holder, null))?.stoppedByUserAt).toBeNull();
    expect((await store.findByHolder(holder))?.stoppedByUserAt).toBeNull();
    expect(await store.setStoppedByUser({ kind: 'workspace', id: createId() }, stoppedAt)).toBeNull();
  });
});

describe('createDbDevPreviewGrantsStore', () => {
  const store = createDbDevPreviewGrantsStore();
  const holder = { kind: 'env', id: envId } as const;

  it('mints a grant bound to (holder, user) with the two expiries fixed at mint time', async () => {
    const minted = await store.mint({ holder, userId, sessionId, now: NOW });
    expect(minted.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(minted.expiresAt).toEqual(new Date(NOW.getTime() + PREVIEW_GRANT_TTL_MS));
    expect(minted.cookieExpiresAt).toEqual(new Date(NOW.getTime() + PREVIEW_COOKIE_TTL_MS));
    const [row] = await db.select().from(devPreviewGrants).where(eq(devPreviewGrants.id, minted.id));
    expect(row).toMatchObject({ holderKind: 'env', holderId: envId, userId, sessionId, consumedAt: null });
  });

  it('consumes exactly once: the first redemption returns the claims, the second returns null', async () => {
    const minted = await store.mint({ holder, userId, sessionId, now: NOW });
    const later = new Date(NOW.getTime() + 1000);
    expect(await store.consume({ id: minted.id, now: later })).toEqual({ holder: { kind: 'env', id: envId }, userId, sessionId, cookieExpiresAt: minted.cookieExpiresAt });
    expect(await store.consume({ id: minted.id, now: later })).toBeNull();
    const [row] = await db.select({ consumedAt: devPreviewGrants.consumedAt }).from(devPreviewGrants).where(eq(devPreviewGrants.id, minted.id));
    expect(row.consumedAt).toEqual(later);
  });

  it('under a concurrent race, exactly one of N redemptions wins', async () => {
    const minted = await store.mint({ holder, userId, sessionId, now: NOW });
    const later = new Date(NOW.getTime() + 1000);
    const results = await Promise.all(Array.from({ length: 8 }, () => store.consume({ id: minted.id, now: later })));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('refuses an expired grant, an unknown id, and a malformed id', async () => {
    const minted = await store.mint({ holder, userId, sessionId, now: NOW });
    expect(await store.consume({ id: minted.id, now: new Date(minted.expiresAt.getTime()) })).toBeNull();
    expect(await store.consume({ id: 'A'.repeat(43), now: NOW })).toBeNull();
    expect(await store.consume({ id: 'not-a-grant', now: NOW })).toBeNull();
    expect(await store.consume({ id: `${minted.id}'; --`, now: NOW })).toBeNull();
  });

  it('a deleted session takes its unredeemed grants with it (the FK cascade)', async () => {
    const doomedSession = createId();
    await db.insert(sessions).values({
      id: doomedSession, tokenHash: `h-${doomedSession}`, tokenPrefix: 'ps_', userId, type: 'user',
      tokenVersion: 1, expiresAt: new Date(NOW.getTime() + 86_400_000),
    });
    const minted = await store.mint({ holder, userId, sessionId: doomedSession, now: NOW });
    await db.delete(sessions).where(eq(sessions.id, doomedSession));
    expect(await db.select().from(devPreviewGrants).where(eq(devPreviewGrants.id, minted.id))).toHaveLength(0);
  });

  it('sweeps grants an hour past expiry on the next mint', async () => {
    const old = await store.mint({ holder, userId, sessionId, now: new Date(NOW.getTime() - 3 * 60 * 60 * 1000) });
    await store.mint({ holder, userId, sessionId, now: NOW });
    const rows = await db.select().from(devPreviewGrants).where(eq(devPreviewGrants.id, old.id));
    expect(rows).toHaveLength(0);
  });
});
