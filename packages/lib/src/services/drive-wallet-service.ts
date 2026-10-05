/**
 * drive-wallet-service — the imperative shell behind the wallet routes (Spec SPEND-2,
 * SPEND-3, SPEND-9, SPEND-10, UI-9, UI-10, WAL-3, WAL-4, WAL-7; X-1 through the CLI and MCP,
 * which call the same routes).
 *
 * Every entry point decides access the same way: the person's standing in the drive is loaded
 * through the permissions module (`loadDriveWalletStanding`: the one org-aware membership
 * model, audited org power, the ACCEPTED org role) and judged by `wallet-access`; what a viewer
 * sees is picked by `wallet-views`' per-role allowlist; money moves are planned by
 * `wallet-admin` and written here under row locks. A person with no access to the drive gets
 * 404 (whether a drive or its wallet exists is itself drive data); a person with access but
 * not the action gets 403.
 *
 * Dark while ORGS_ENABLED is false: drive wallets are not resolved by the gate then, so the
 * surfaces that configure them answer 404. The personal default and the conversation source
 * work regardless (they are personal), and answer own credits while dark.
 */

import { db } from '@pagespace/db/db';
import { and, eq, gt, gte, inArray, isNull, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { conversations } from '@pagespace/db/schema/conversations';
import { drives, pages } from '@pagespace/db/schema/core';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { orgMembers, organizations } from '@pagespace/db/schema/organizations';
import {
  wallets,
  walletConsumerCaps,
  driveSpendOverrides,
  walletFundingLegs,
  personalRootWalletOf,
  type SpendSourceKindValue,
} from '@pagespace/db/schema/wallets';
import { isBillingEnabled } from '../deployment-mode';
import { ORGS_ENABLED } from '../organizations/orgs-enabled';
import { getDriveIdsForUser, getUserDriveAccess } from '../permissions/permissions';
import { loadDriveWalletStanding, type DriveWalletStanding } from '../permissions/spend-standing';
import {
  credentialRefusalFor,
  decideSeatCapWrite,
  mayTakeWalletAction,
  viewerForCredential,
  walletActionsFor,
  walletViewerRole,
  type WalletAction,
  type WalletCredential,
  type WalletViewer,
  type WalletWrite,
} from '../permissions/wallet-access';
import { ensurePersonalRootWalletId } from '../billing/personal-wallet';
import { listSpendChoices, resolveCallSpend, type SpendChoice } from '../billing/spend-resolution';
import { conversationSpend, type CallSpendDecision } from '../billing/spend-target';
import { formatCreditCount } from '../billing/money-model';
import { toSubscriptionTier } from '../billing/subscription-tiers';
import { planDeleteWallet, planTopUp, planWalletPatch, type DeleteBlocker, type WalletPatchInput } from '../billing/wallet-admin';
import { donateToDriveWallet } from '../billing/wallet-funding-shell';
import { checkOrgActive } from '../organizations/status';
import { findMembershipRole } from '../organizations/repository';
import { planConsumerCapWrite, userConsumerKey, utcDayStartMs, utcMonthStartMs, type ConsumerCapWriteInput, type SpendSourceKind } from '../billing/wallet-core';
import {
  capRemainingCents,
  displayedWalletStatus,
  projectDriveWallet,
  walletRemainingCents,
  type ConsumerSpend,
  type DriveWalletFacts,
  type DriveWalletView,
  type PoolFacts,
} from '../billing/wallet-views';
import { recordOrgAuditEventAfterCommit } from '../audit/org-audit';
import { decryptUserRow } from '../auth/user-repository';
import { announceDriveWalletChange, announceWalletChange } from '../billing/wallet-change-events';
import { announceOrgChange } from '../organizations/org-change-events';

export interface WalletServiceError {
  ok: false;
  status: 400 | 402 | 403 | 404 | 409;
  code: string;
  message: string;
  blockers?: DeleteBlocker[];
}

const notFound = (message = 'Drive not found'): WalletServiceError => ({ ok: false, status: 404, code: 'not_found', message });
const forbidden = (action: WalletAction): WalletServiceError => ({
  ok: false,
  status: 403,
  code: 'insufficient_role',
  message: `You cannot ${action.replace(/_/g, ' ')} this drive's wallet`,
});

/**
 * [D-OW-26] Refuse a write made with a delegated token, by name, before anything is read or
 * written. Every write entry point below calls this first.
 */
function refuseCredential(credential: WalletCredential, write: WalletWrite): WalletServiceError | null {
  const refusal = credentialRefusalFor(credential, write);
  return refusal ? { ok: false, status: 403, code: refusal.code, message: refusal.message } : null;
}

/** The consumer key a person's cap is stored under on a wallet (WAL-7); defined once in wallet-core. */
export { userConsumerKey };

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

interface WalletAccess {
  ok: true;
  standing: DriveWalletStanding;
  viewer: Exclude<WalletViewer, 'none'>;
  orgDrive: boolean;
  actions: WalletAction[];
}

async function walletAccess(userId: string, driveId: string, credential: WalletCredential): Promise<WalletAccess | WalletServiceError> {
  if (!ORGS_ENABLED) return notFound();
  const standing = await loadDriveWalletStanding(userId, driveId);
  if (!standing) return notFound();
  const role = walletViewerRole(standing);
  if (role === 'none') return notFound();
  // [D-OW-26] a token reads as a consumer and may take no write, whatever the person's role.
  const viewer = viewerForCredential(role, credential);
  const orgDrive = standing.orgId !== null;
  const actions = walletActionsFor(viewer, { orgDrive }).filter((a) => credential === 'session' || a === 'view');
  return { ok: true, standing, viewer, orgDrive, actions };
}

function requireAction(access: WalletAccess, action: WalletAction): WalletServiceError | null {
  return mayTakeWalletAction(access.viewer, action, { orgDrive: access.orgDrive }) ? null : forbidden(action);
}

/**
 * SEAT-9: the org pool and its allocations are an org-only capability. While the drive's
 * org is lapsed every wallet WRITE on an org drive is refused (allocate, rules, pause,
 * delete, top up, donate) — nothing moves, so no credit is deleted or reallocated; reads
 * stay open. A personal drive's wallet has no org and is never affected.
 */
async function requireOrgActiveForWrite(access: WalletAccess): Promise<WalletServiceError | null> {
  if (access.standing.orgId === null) return null;
  const active = await checkOrgActive(access.standing.orgId);
  return active.ok ? null : { ok: false, status: active.status, code: active.code, message: active.message };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const WALLET_ROW = {
  id: wallets.id,
  subjectId: wallets.subjectId,
  parentWalletId: wallets.parentWalletId,
  status: wallets.status,
  monthlyAllowanceCents: wallets.monthlyAllowanceCents,
  spentCents: wallets.spentCents,
  topupRemainingCents: wallets.topupRemainingCents,
  debtCents: wallets.debtCents,
  monthlyPeriodStart: wallets.monthlyPeriodStart,
  monthlyPeriodEnd: wallets.monthlyPeriodEnd,
  fallbackRule: wallets.fallbackRule,
  donationsEnabled: wallets.donationsEnabled,
  defaultSpendSource: wallets.defaultSpendSource,
  overshootChoice: wallets.overshootChoice,
} as const;

async function driveWalletRow(executor: Pick<typeof db, 'select'>, driveId: string) {
  const [row] = await executor
    .select(WALLET_ROW)
    .from(wallets)
    .where(and(eq(wallets.subjectType, 'drive'), eq(wallets.subjectId, driveId)))
    .limit(1);
  return row ?? null;
}

async function orgPoolRow(executor: Pick<typeof db, 'select'>, orgId: string) {
  const [row] = await executor
    .select({
      id: wallets.id,
      monthlyRemainingCents: wallets.monthlyRemainingCents,
      topupRemainingCents: wallets.topupRemainingCents,
      debtCents: wallets.debtCents,
      monthlyPeriodStart: wallets.monthlyPeriodStart,
      monthlyPeriodEnd: wallets.monthlyPeriodEnd,
    })
    .from(wallets)
    .where(and(eq(wallets.ownerType, 'org'), eq(wallets.orgId, orgId), isNull(wallets.subjectType), isNull(wallets.parentWalletId)))
    .limit(1);
  return row ?? null;
}

async function liveHeldCents(
  executor: Pick<typeof db, 'select'>,
  walletIds: string[],
  includeChildrenOf: string[] = [],
): Promise<number> {
  if (walletIds.length === 0 && includeChildrenOf.length === 0) return 0;
  const now = new Date();
  const [row] = await executor
    .select({ cents: sql<number>`coalesce(sum(${creditHolds.estCents}), 0)::int` })
    .from(creditHolds)
    .innerJoin(wallets, eq(wallets.id, creditHolds.walletId))
    .where(and(
      gt(creditHolds.expiresAt, now),
      includeChildrenOf.length > 0
        ? sql`(${inArray(wallets.id, [...walletIds, ...includeChildrenOf])} OR ${inArray(wallets.parentWalletId, includeChildrenOf)})`
        : inArray(wallets.id, walletIds),
    ));
  return Number(row?.cents ?? 0);
}

/** A person's usage on one wallet since `since` (usage rows carry the negative applied cents). */
async function usageCentsSince(walletId: string, userId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ cents: sql<number>`coalesce(-sum(${creditLedger.appliedCents}), 0)::int` })
    .from(creditLedger)
    .where(and(
      eq(creditLedger.walletId, walletId),
      eq(creditLedger.userId, userId),
      eq(creditLedger.entryType, 'usage'),
      gte(creditLedger.createdAt, since),
    ));
  return Math.max(0, Number(row?.cents ?? 0));
}

async function myCapFacts(walletId: string, userId: string): Promise<DriveWalletFacts['myCap']> {
  const [cap] = await db
    .select({ dailyCapCents: walletConsumerCaps.dailyCapCents, monthlyCapCents: walletConsumerCaps.monthlyCapCents })
    .from(walletConsumerCaps)
    .where(and(eq(walletConsumerCaps.walletId, walletId), eq(walletConsumerCaps.consumerKey, userConsumerKey(userId))))
    .limit(1);
  if (!cap) return null;
  const nowMs = Date.now();
  return {
    dailyCapCents: cap.dailyCapCents,
    monthlyCapCents: cap.monthlyCapCents,
    spentTodayCents: await usageCentsSince(walletId, userId, new Date(utcDayStartMs(nowMs))),
    spentThisMonthCents: await usageCentsSince(walletId, userId, new Date(utcMonthStartMs(nowMs))),
  };
}

/** Spend on the wallet this period, per consumer (SPEND-10). Loaded only for a viewer who may see it. */
async function spendByConsumer(walletId: string, since: Date | null): Promise<ConsumerSpend[]> {
  const rows = await db
    .select({ userId: creditLedger.userId, cents: sql<number>`coalesce(-sum(${creditLedger.appliedCents}), 0)::int` })
    .from(creditLedger)
    .where(and(
      eq(creditLedger.walletId, walletId),
      eq(creditLedger.entryType, 'usage'),
      since ? gte(creditLedger.createdAt, since) : undefined,
    ))
    .groupBy(creditLedger.userId)
    .limit(500);
  const names = await userNamesById(rows.map((r) => r.userId));
  return rows
    .map((r) => ({ consumerKey: userConsumerKey(r.userId), userId: r.userId, displayName: names.get(r.userId) ?? null, spentCents: Math.max(0, Number(r.cents)) }))
    .sort((a, b) => b.spentCents - a.spentCents || a.consumerKey.localeCompare(b.consumerKey));
}

/** People's display names by id (decrypted), so no wallet surface hands the UI a raw id alone (UI-9, UI-10). */
async function userNamesById(userIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Map();
  const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, unique));
  const out = new Map<string, string>();
  for (const row of rows) {
    const name = (await decryptUserRow({ name: row.name })).name;
    if (name) out.set(row.id, name);
  }
  return out;
}

/** Drive names by id, for wallet lists (UI-10). */
async function driveNamesById(driveIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(driveIds)];
  if (unique.length === 0) return new Map();
  const rows = await db.select({ id: drives.id, name: drives.name }).from(drives).where(inArray(drives.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Org names by id, for wallet lists (UI-10). */
async function orgNamesById(orgIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(orgIds)];
  if (unique.length === 0) return new Map();
  const rows = await db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(inArray(organizations.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function poolFacts(orgId: string): Promise<PoolFacts | null> {
  const pool = await orgPoolRow(db, orgId);
  if (!pool) return null;
  const [children] = await db
    .select({ outstanding: sql<number>`coalesce(sum(greatest(${wallets.monthlyAllowanceCents} - ${wallets.spentCents}, 0)), 0)::int` })
    .from(wallets)
    .where(eq(wallets.parentWalletId, pool.id));
  const held = await liveHeldCents(db, [], [pool.id]);
  return {
    walletId: pool.id,
    availableCents: pool.monthlyRemainingCents + pool.topupRemainingCents - pool.debtCents - held,
    outstandingChildAllocationsCents: Number(children?.outstanding ?? 0),
  };
}

export interface DriveWalletRead {
  ok: true;
  viewer: Exclude<WalletViewer, 'none'>;
  actions: WalletAction[];
  /** Null when the drive has no wallet yet. */
  wallet: DriveWalletView | null;
}

async function readView(userId: string, access: WalletAccess): Promise<DriveWalletRead> {
  const row = await driveWalletRow(db, access.standing.driveId);
  if (!row) return { ok: true, viewer: access.viewer, actions: access.actions, wallet: null };
  // Only what this viewer may see is even loaded: spend by consumer for the lead and org
  // admins, the pool for org admins.
  const seesSpend = mayTakeWalletAction(access.viewer, 'view_spend_by_member', { orgDrive: access.orgDrive });
  const facts: DriveWalletFacts = {
    wallet: {
      id: row.id,
      driveId: access.standing.driveId,
      status: row.status,
      monthlyAllowanceCents: row.monthlyAllowanceCents,
      spentCents: row.spentCents,
      topupRemainingCents: row.topupRemainingCents,
      debtCents: row.debtCents,
      monthlyPeriodStart: row.monthlyPeriodStart,
      monthlyPeriodEnd: row.monthlyPeriodEnd,
      fallbackRule: row.fallbackRule,
      donationsEnabled: row.donationsEnabled,
      defaultSpendSource: row.defaultSpendSource,
      overshootChoice: row.overshootChoice,
    },
    myCap: await myCapFacts(row.id, userId),
    spendByConsumer: seesSpend ? await spendByConsumer(row.id, row.monthlyPeriodStart) : [],
    pool: access.viewer === 'org_admin' && access.standing.orgId ? await poolFacts(access.standing.orgId) : null,
  };
  return { ok: true, viewer: access.viewer, actions: access.actions, wallet: projectDriveWallet(access.viewer, facts) };
}

/** GET a drive's wallet as this person may see it (SPEND-9, SPEND-10, UI-9). */
export async function getDriveWallet(userId: string, driveId: string, credential: WalletCredential): Promise<DriveWalletRead | WalletServiceError> {
  const access = await walletAccess(userId, driveId, credential);
  if (!access.ok) return access;
  return readView(userId, access);
}

// ---------------------------------------------------------------------------
// Create, change, delete (UI-9)
// ---------------------------------------------------------------------------

/**
 * Seams for the concurrency tests only: `afterAccess` runs between the access decision and the write's
 * transaction (where a drive move can land), `afterDriveLock` inside the transaction once the drive row is
 * held. Production passes neither.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface WalletWriteHooks {
  afterAccess?: () => Promise<void>;
  afterDriveLock?: () => Promise<void>;
}

const driveMoved = (): WalletServiceError => ({
  ok: false,
  status: 409,
  code: 'drive_moved',
  message: 'This drive moved into or out of an organization while the change was being made; try again',
});

/**
 * Inside a wallet write's transaction, FIRST (before any wallet row, so the lock order is drive then
 * wallets, as a move takes it): share-lock the drive row, which a move into or out of an org holds FOR
 * UPDATE, and confirm its org is still the one access was decided on. So the write, its funder and its
 * org audit event all belong to the drive's org at commit, never to the org it just left.
 */
async function lockDriveOrgStanding(tx: Tx, driveId: string, expectedOrgId: string | null): Promise<WalletServiceError | null> {
  const [drive] = await tx.select({ orgId: drives.orgId }).from(drives).where(eq(drives.id, driveId)).for('share');
  if (!drive) return notFound();
  return drive.orgId === expectedOrgId ? null : driveMoved();
}

/** AUD-1: a change to an ORG drive's wallet, once committed. A personal drive's wallet is no org's business. */
async function recordOrgWalletEvent(
  standing: { orgId: string | null; driveId: string },
  userId: string,
  eventType: 'org.wallet.allocation_changed' | 'org.wallet.topped_up' | 'org.wallet.donated',
  details: Record<string, unknown>,
): Promise<void> {
  if (standing.orgId === null) return;
  await recordOrgAuditEventAfterCommit({
    orgId: standing.orgId,
    driveId: standing.driveId,
    eventType,
    actorId: userId,
    resourceType: 'drive_wallet',
    resourceId: standing.driveId,
    details,
  });
}

/**
 * Create the drive's wallet under its parent (WAL-2): the org pool for an org drive, the
 * lead's personal wallet for a personal drive. Its allocation period follows the parent's
 * (D-OW-12); the reset sweep keeps it there.
 */
export async function createDriveWallet(
  userId: string,
  driveId: string,
  input: { allocationCents: number },
  credential: WalletCredential,
  hooks: WalletWriteHooks = {},
): Promise<DriveWalletRead | WalletServiceError> {
  const refused = refuseCredential(credential, 'create');
  if (refused) return refused;
  const access = await walletAccess(userId, driveId, credential);
  if (!access.ok) return access;
  const denied = requireAction(access, 'create') ?? (await requireOrgActiveForWrite(access));
  if (denied) return denied;
  const plan = planWalletPatch({ allocationCents: input.allocationCents }, { status: 'active', debtCents: 0 });
  if (plan.kind === 'refuse') return { ok: false, status: 400, code: plan.reason, message: 'The allocation must be a whole, non-negative number of cents' };

  const { standing } = access;
  await hooks.afterAccess?.();
  const created = await db.transaction(async (tx) => {
    const moved = await lockDriveOrgStanding(tx, driveId, standing.orgId);
    if (moved) return moved;
    await hooks.afterDriveLock?.();
    let parent: { id: string; monthlyPeriodStart: Date | null; monthlyPeriodEnd: Date | null } | null;
    if (standing.orgId !== null) {
      parent = await orgPoolRow(tx, standing.orgId);
    } else {
      const parentId = await ensurePersonalRootWalletId(tx, standing.ownerId);
      const [row] = await tx
        .select({ id: wallets.id, monthlyPeriodStart: wallets.monthlyPeriodStart, monthlyPeriodEnd: wallets.monthlyPeriodEnd })
        .from(wallets)
        .where(eq(wallets.id, parentId));
      parent = row ?? null;
    }
    if (!parent) return 'no_parent' as const;
    const inserted = await tx
      .insert(wallets)
      .values({
        ownerType: standing.orgId !== null ? 'org' : 'user',
        orgId: standing.orgId,
        userId: standing.orgId !== null ? null : standing.ownerId,
        subjectType: 'drive',
        subjectId: standing.driveId,
        parentWalletId: parent.id,
        monthlyAllowanceCents: input.allocationCents,
        monthlyPeriodStart: parent.monthlyPeriodStart,
        monthlyPeriodEnd: parent.monthlyPeriodEnd,
      })
      .onConflictDoNothing({ target: [wallets.subjectType, wallets.subjectId], where: sql`"subjectId" IS NOT NULL` })
      .returning({ id: wallets.id });
    return inserted.length > 0 ? ('created' as const) : ('exists' as const);
  });
  if (typeof created === 'object') return created;
  if (created === 'no_parent') {
    return { ok: false, status: 409, code: 'no_org_pool', message: 'This organization has no pool to allocate from yet' };
  }
  if (created === 'exists') return { ok: false, status: 409, code: 'wallet_exists', message: 'This drive already has a wallet' };
  await recordOrgWalletEvent(standing, userId, 'org.wallet.allocation_changed', { operation: 'create', allocationCents: input.allocationCents });
  void announceDriveWalletChange(driveId, 'allocation');
  return readView(userId, access);
}

/** Change a drive wallet's allocation, pause state, rules or default source; each field is its own action. */
export async function updateDriveWallet(
  userId: string,
  driveId: string,
  input: WalletPatchInput,
  credential: WalletCredential,
  hooks: WalletWriteHooks = {},
): Promise<DriveWalletRead | WalletServiceError> {
  // Every field of a change is a write (allocate, pause, rules): a token may make none of them.
  const refused = refuseCredential(credential, input.allocationCents !== undefined || input.overshootChoice !== undefined ? 'allocate' : input.paused !== undefined ? 'pause' : 'set_rules');
  if (refused) return refused;
  const access = await walletAccess(userId, driveId, credential);
  if (!access.ok) return access;
  const lapsed = await requireOrgActiveForWrite(access);
  if (lapsed) return lapsed;

  let applied: Record<string, unknown> = {};
  await hooks.afterAccess?.();
  const outcome = await db.transaction(async (tx): Promise<WalletServiceError | null> => {
    const moved = await lockDriveOrgStanding(tx, driveId, access.standing.orgId);
    if (moved) return moved;
    await hooks.afterDriveLock?.();
    const [row] = await tx
      .select({ id: wallets.id, status: wallets.status, debtCents: wallets.debtCents })
      .from(wallets)
      .where(and(eq(wallets.subjectType, 'drive'), eq(wallets.subjectId, driveId)))
      .for('update');
    if (!row) return { ok: false, status: 404, code: 'no_wallet', message: 'This drive has no wallet' };
    const plan = planWalletPatch(input, row);
    if (plan.kind === 'refuse') {
      return { ok: false, status: 400, code: plan.reason, message: plan.reason === 'invalid_amount' ? 'The allocation must be a whole, non-negative number of cents' : 'Nothing to change' };
    }
    for (const action of plan.actions) {
      const denied = requireAction(access, action);
      if (denied) return denied;
    }
    await tx.update(wallets).set(plan.set).where(eq(wallets.id, row.id));
    applied = { ...plan.set };
    return null;
  });
  if (outcome) return outcome;
  await recordOrgWalletEvent(access.standing, userId, 'org.wallet.allocation_changed', { operation: 'update', changes: applied });
  void announceDriveWalletChange(driveId, input.allocationCents !== undefined ? 'allocation' : input.paused !== undefined ? 'status' : 'rules');
  return readView(userId, access);
}

/** Delete a drive wallet that never moved money; anything else is paused instead (wallet-admin). */
export async function deleteDriveWallet(
  userId: string,
  driveId: string,
  credential: WalletCredential,
  hooks: WalletWriteHooks = {},
): Promise<{ ok: true } | WalletServiceError> {
  const refused = refuseCredential(credential, 'delete');
  if (refused) return refused;
  const access = await walletAccess(userId, driveId, credential);
  if (!access.ok) return access;
  const denied = requireAction(access, 'delete') ?? (await requireOrgActiveForWrite(access));
  if (denied) return denied;

  await hooks.afterAccess?.();
  const deleted = await db.transaction(async (tx): Promise<{ ok: true } | WalletServiceError> => {
    const moved = await lockDriveOrgStanding(tx, driveId, access.standing.orgId);
    if (moved) return moved;
    await hooks.afterDriveLock?.();
    const [row] = await tx
      .select({ id: wallets.id, topupRemainingCents: wallets.topupRemainingCents, debtCents: wallets.debtCents })
      .from(wallets)
      .where(and(eq(wallets.subjectType, 'drive'), eq(wallets.subjectId, driveId)))
      .for('update');
    if (!row) return { ok: false, status: 404, code: 'no_wallet', message: 'This drive has no wallet' };
    const [holds] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(creditHolds)
      .where(and(eq(creditHolds.walletId, row.id), gt(creditHolds.expiresAt, new Date())));
    const [ledger] = await tx.select({ n: sql<number>`count(*)::int` }).from(creditLedger).where(eq(creditLedger.walletId, row.id));
    const [legs] = await tx
      .select({ cents: sql<number>`coalesce(sum(${walletFundingLegs.remainingCents}), 0)::int` })
      .from(walletFundingLegs)
      .where(eq(walletFundingLegs.walletId, row.id));
    const plan = planDeleteWallet({
      liveHoldCount: Number(holds?.n ?? 0),
      ledgerEntryCount: Number(ledger?.n ?? 0),
      legsRemainingCents: Math.max(Number(legs?.cents ?? 0), row.topupRemainingCents),
      debtCents: row.debtCents,
    });
    if (plan.kind === 'refuse') {
      return { ok: false, status: 409, code: plan.reason, message: 'This wallet has moved money; pause it instead of deleting it', blockers: plan.blockers };
    }
    await tx.delete(wallets).where(eq(wallets.id, row.id));
    return { ok: true };
  });
  if (deleted.ok) await recordOrgWalletEvent(access.standing, userId, 'org.wallet.allocation_changed', { operation: 'delete' });
  return deleted;
}

// ---------------------------------------------------------------------------
// Money in: top-up (WAL-3) and donation (WAL-4)
// ---------------------------------------------------------------------------

/**
 * Top up a drive wallet from its funder: the org pool for an org drive (org admins only), the
 * lead's own personal wallet for a personal drive. One owner funding leg per `idempotencyKey`.
 */
export async function topUpDriveWallet(
  userId: string,
  driveId: string,
  input: { amountCents: number; idempotencyKey: string },
  credential: WalletCredential,
  hooks: WalletWriteHooks = {},
): Promise<{ ok: true; legId: string; amountCents: number; paidDebtCents: number; duplicate: boolean } | WalletServiceError> {
  const refused = refuseCredential(credential, 'top_up');
  if (refused) return refused;
  const access = await walletAccess(userId, driveId, credential);
  if (!access.ok) return access;
  const denied = requireAction(access, 'top_up') ?? (await requireOrgActiveForWrite(access));
  if (denied) return denied;
  if (!isBillingEnabled()) return { ok: false, status: 409, code: 'billing_disabled', message: 'Billing is not enabled on this deployment' };

  const { standing } = access;
  const sourceRef = `topup:${input.idempotencyKey}`;
  const target = await driveWalletRow(db, driveId);
  if (!target) return { ok: false, status: 404, code: 'no_wallet', message: 'This drive has no wallet' };
  const payerId = standing.orgId !== null
    ? (await orgPoolRow(db, standing.orgId))?.id ?? null
    : await ensurePersonalRootWalletId(db, standing.ownerId);
  if (!payerId) return { ok: false, status: 409, code: 'no_org_pool', message: 'This organization has no pool to pay from' };

  await hooks.afterAccess?.();
  const result = await db.transaction(async (tx) => {
    // The payer was chosen from the drive's org; a move since then would fund it from the wrong one.
    const moved = await lockDriveOrgStanding(tx, driveId, standing.orgId);
    if (moved) return moved;
    await hooks.afterDriveLock?.();
    // The global wallet lock order (billing/wallet-legs): the drive (child) wallet, then its
    // parent — here the payer, the org pool or the lead's personal root. An id sort could take
    // the parent first and deadlock against a settle or a donation into the same wallet.
    const locked = new Map<string, typeof wallets.$inferSelect>();
    for (const id of [target.id, payerId]) {
      const [row] = await tx.select().from(wallets).where(eq(wallets.id, id)).for('update');
      if (row) locked.set(id, row);
    }
    const payer = locked.get(payerId);
    const drive = locked.get(target.id);
    if (!payer || !drive) return { ok: false as const, status: 404 as const, code: 'no_wallet', message: 'The wallet was removed' };
    // A replay is a duplicate, checked AFTER the drive wallet's lock: a request racing the same
    // key waits on that lock and then sees the other's committed leg (the insert's ON CONFLICT
    // below stays as the backstop), so a retry never fails and never moves money twice.
    const duplicate = async () => {
      const [prior] = await tx.select({ id: walletFundingLegs.id }).from(walletFundingLegs).where(eq(walletFundingLegs.sourceRef, sourceRef)).limit(1);
      return prior ? { ok: true as const, legId: prior.id, amountCents: input.amountCents, paidDebtCents: 0, duplicate: true } : null;
    };
    const replay = await duplicate();
    if (replay) return replay;
    // What in-flight calls reserve against the payer, read AFTER the locks so a hold placed
    // meanwhile is counted: its own holds and its children's, since a child wallet's
    // allocation draws on its parent (the org pool, or the lead's personal wallet) — the
    // same rule the gate uses (spend-resolution: includeChildren on the root).
    const held = await liveHeldCents(tx, [payerId], [payerId]);

    const plan = planTopUp({
      amountCents: input.amountCents,
      payer: { walletId: payer.id, balance: { monthlyCents: payer.monthlyRemainingCents, topupCents: payer.topupRemainingCents, debtCents: payer.debtCents }, heldCents: held },
      target: { walletId: drive.id, legsRemainingCents: drive.topupRemainingCents, debtCents: drive.debtCents },
    });
    if (plan.kind === 'refuse') {
      return plan.reason === 'insufficient_funds'
        ? { ok: false as const, status: 402 as const, code: plan.reason, message: 'The funding wallet cannot cover this top-up' }
        : { ok: false as const, status: 400 as const, code: plan.reason, message: 'The amount must be a positive whole number of cents' };
    }
    const [leg] = await tx
      .insert(walletFundingLegs)
      .values({
        walletId: drive.id,
        funderKind: 'owner',
        funderUserId: standing.orgId === null ? standing.ownerId : null,
        funderOrgId: standing.orgId,
        originalCents: plan.leg.originalCents,
        remainingCents: plan.leg.remainingCents,
        nonRefundable: plan.leg.nonRefundable,
        sourceRef,
      })
      .onConflictDoNothing({ target: walletFundingLegs.sourceRef, where: sql`"sourceRef" IS NOT NULL` })
      .returning({ id: walletFundingLegs.id });
    if (!leg) {
      const raced = await duplicate();
      if (raced) return raced;
      throw new Error(`top-up ${sourceRef}: the leg neither inserted nor exists`);
    }
    await tx
      .update(wallets)
      .set({ monthlyRemainingCents: plan.payer.monthlyRemainingCents, topupRemainingCents: plan.payer.topupRemainingCents })
      .where(eq(wallets.id, payer.id));
    await tx
      .update(wallets)
      .set({
        topupRemainingCents: plan.target.topupRemainingCents,
        debtCents: plan.target.debtCents,
        ...(drive.status === 'over' && plan.target.debtCents === 0 ? { status: 'active' as const } : {}),
      })
      .where(eq(wallets.id, drive.id));
    await tx.insert(creditLedger).values([
      {
        userId,
        walletId: payer.id,
        entryType: 'wallet_topup',
        bucket: plan.payer.spentTopup > plan.payer.spentMonthly ? 'topup' : 'monthly',
        amountCents: -plan.amountCents,
        appliedCents: -plan.amountCents,
        stripeRef: `topup-out:${input.idempotencyKey}`,
        consumeStatus: 'applied',
      },
      {
        userId,
        walletId: drive.id,
        entryType: 'wallet_topup',
        bucket: 'topup',
        amountCents: plan.amountCents,
        appliedCents: plan.amountCents,
        stripeRef: `topup-in:${input.idempotencyKey}`,
        consumeStatus: 'applied',
      },
    ]);
    return { ok: true as const, legId: leg.id, amountCents: plan.amountCents, paidDebtCents: plan.target.paidDebtCents, duplicate: false };
  });
  if (result.ok && !result.duplicate) {
    await recordOrgWalletEvent(standing, userId, 'org.wallet.topped_up', { amountCents: result.amountCents, paidDebtCents: result.paidDebtCents, legId: result.legId });
    void announceDriveWalletChange(driveId, 'balance');
  }
  return result;
}

// ---------------------------------------------------------------------------
// Per-consumer caps (WAL-7)
// ---------------------------------------------------------------------------

/** One consumer's caps on a leg, as the wallet surfaces show them: cents plus credit counts, and their name. */
export interface ConsumerCapView {
  userId: string;
  displayName: string;
  dailyCapCents: number | null;
  monthlyCapCents: number | null;
  dailyCapCredits: string | null;
  monthlyCapCredits: string | null;
}

export interface WalletCapsRead {
  ok: true;
  walletId: string;
  caps: ConsumerCapView[];
}

function capView(row: { userId: string; name: string | null; dailyCapCents: number | null; monthlyCapCents: number | null }): ConsumerCapView {
  return {
    userId: row.userId,
    displayName: row.name ?? 'Unknown user',
    dailyCapCents: row.dailyCapCents,
    monthlyCapCents: row.monthlyCapCents,
    dailyCapCredits: row.dailyCapCents === null ? null : formatCreditCount(row.dailyCapCents),
    monthlyCapCredits: row.monthlyCapCents === null ? null : formatCreditCount(row.monthlyCapCents),
  };
}

/** Every person's caps on `walletId`, by name. */
async function capsOnWallet(walletId: string): Promise<ConsumerCapView[]> {
  const rows = await db
    .select({
      consumerKey: walletConsumerCaps.consumerKey,
      dailyCapCents: walletConsumerCaps.dailyCapCents,
      monthlyCapCents: walletConsumerCaps.monthlyCapCents,
      name: users.name,
    })
    .from(walletConsumerCaps)
    .leftJoin(users, sql`${walletConsumerCaps.consumerKey} = 'user:' || ${users.id}`)
    .where(eq(walletConsumerCaps.walletId, walletId));
  const people = rows.filter((r) => r.consumerKey.startsWith('user:'));
  const views = await Promise.all(people.map(async (r) => capView({
    userId: r.consumerKey.slice('user:'.length),
    name: (await decryptUserRow({ name: r.name })).name ?? null,
    dailyCapCents: r.dailyCapCents,
    monthlyCapCents: r.monthlyCapCents,
  })));
  return views
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

const noWallet = (): WalletServiceError => ({ ok: false, status: 404, code: 'no_wallet', message: 'This drive has no wallet' });
const invalidCap = (): WalletServiceError => ({ ok: false, status: 400, code: 'invalid_amount', message: 'A cap must be a whole, non-negative number of cents, or null for no cap' });
const notAConsumer = (): WalletServiceError => ({ ok: false, status: 404, code: 'not_a_consumer', message: 'That person cannot spend in this drive' });

/** The caps set on a drive's wallet, per person (WAL-7). For whoever may set them, and the lead. */
export async function listDriveWalletCaps(userId: string, driveId: string, credential: WalletCredential): Promise<WalletCapsRead | WalletServiceError> {
  const access = await walletAccess(userId, driveId, credential);
  if (!access.ok) return access;
  if (!access.actions.includes('set_caps') && !access.actions.includes('view_spend_by_member')) return forbidden('set_caps');
  const row = await driveWalletRow(db, driveId);
  if (!row) return noWallet();
  return { ok: true, walletId: row.id, caps: await capsOnWallet(row.id) };
}

/**
 * Write one person's caps on a drive's wallet (WAL-7): org admins on an org drive, the lead (the
 * wallet's owner) on a personal drive — wallet-access `set_caps`. Enabling with nothing named
 * takes the D20.5 defaults; null in a window is no cap there. The person must be able to spend
 * in the drive. `null` input clears the row (unlimited within the wallet).
 */
export async function setDriveWalletCap(
  userId: string,
  driveId: string,
  consumerId: string,
  input: ConsumerCapWriteInput | null,
  credential: WalletCredential,
  hooks: WalletWriteHooks = {},
): Promise<WalletCapsRead | WalletServiceError> {
  const refused = refuseCredential(credential, 'set_caps');
  if (refused) return refused;
  const access = await walletAccess(userId, driveId, credential);
  if (!access.ok) return access;
  const denied = requireAction(access, 'set_caps') ?? (await requireOrgActiveForWrite(access));
  if (denied) return denied;
  const consumer = await loadDriveWalletStanding(consumerId, driveId);
  if (!consumer || walletViewerRole(consumer) === 'none') return notAConsumer();
  const row = await driveWalletRow(db, driveId);
  if (!row) return noWallet();
  await hooks.afterAccess?.();
  // The drive must still have the org standing access was decided on, share-locked for the
  // write, like every other wallet write: a personal lead's cap must not land on a leg that
  // became an org's mid-request (drive_moved).
  const written = await writeConsumerCap(row.id, consumerId, input, (tx) => lockDriveOrgStanding(tx, driveId, access.standing.orgId));
  if (written) return written;
  await recordOrgWalletEvent(access.standing, userId, 'org.wallet.allocation_changed', { operation: input === null ? 'clear_consumer_cap' : 'set_consumer_cap', consumerId });
  void announceWalletChange(row.id, 'caps');
  return { ok: true, walletId: row.id, caps: await capsOnWallet(row.id) };
}

/** Upsert (or, for null, delete) one consumer's caps on a leg, under the row's lock. */
async function writeConsumerCap(
  walletId: string,
  consumerId: string,
  input: ConsumerCapWriteInput | null,
  guard?: (tx: Tx) => Promise<WalletServiceError | null>,
): Promise<WalletServiceError | null> {
  const consumerKey = userConsumerKey(consumerId);
  return db.transaction(async (tx): Promise<WalletServiceError | null> => {
    const blocked = guard ? await guard(tx) : null;
    if (blocked) return blocked;
    if (input === null) {
      await tx.delete(walletConsumerCaps).where(and(eq(walletConsumerCaps.walletId, walletId), eq(walletConsumerCaps.consumerKey, consumerKey)));
      return null;
    }
    const [existing] = await tx
      .select({ dailyCents: walletConsumerCaps.dailyCapCents, monthlyCents: walletConsumerCaps.monthlyCapCents })
      .from(walletConsumerCaps)
      .where(and(eq(walletConsumerCaps.walletId, walletId), eq(walletConsumerCaps.consumerKey, consumerKey)))
      .for('update');
    const plan = planConsumerCapWrite(input, existing ?? null);
    if (plan.kind === 'refuse') return invalidCap();
    await tx
      .insert(walletConsumerCaps)
      .values({ walletId, consumerKey, dailyCapCents: plan.caps.dailyCents, monthlyCapCents: plan.caps.monthlyCents })
      .onConflictDoUpdate({
        target: [walletConsumerCaps.walletId, walletConsumerCaps.consumerKey],
        set: { dailyCapCents: plan.caps.dailyCents, monthlyCapCents: plan.caps.monthlyCents, updatedAt: new Date() },
      });
    return null;
  });
}

/**
 * Write one member's caps on the org pool leg — their seat (WAL-7): the org's Owner or an Admin,
 * for an accepted member (wallet-access `decideSeatCapWrite`). The monthly window is the seat
 * allowance for that member (WAL-2); null clears the row back to the org's allowance.
 */
export async function setSeatCap(
  userId: string,
  orgId: string,
  consumerId: string,
  input: ConsumerCapWriteInput | null,
): Promise<WalletCapsRead | WalletServiceError> {
  if (!ORGS_ENABLED) return notFound('Organization not found');
  const decision = decideSeatCapWrite({
    actorRole: await findMembershipRole(orgId, userId),
    consumerRole: await findMembershipRole(orgId, consumerId),
  });
  if (!decision.ok) {
    return { ok: false, status: decision.status, code: decision.code, message: decision.code === 'insufficient_role' ? 'Only the organization Owner or an Admin can set a seat cap' : decision.code === 'not_org_member' ? 'That person is not a member of this organization' : 'Organization not found' };
  }
  const active = await checkOrgActive(orgId);
  if (!active.ok) return { ok: false, status: active.status, code: active.code, message: active.message };
  const pool = await orgPoolRow(db, orgId);
  if (!pool) return { ok: false, status: 409, code: 'no_org_pool', message: 'This organization has no pool yet' };
  const written = await writeConsumerCap(pool.id, consumerId, input);
  if (written) return written;
  await recordOrgAuditEventAfterCommit({
    orgId,
    eventType: 'org.wallet.allocation_changed',
    actorId: userId,
    resourceType: 'org_pool',
    resourceId: pool.id,
    details: { operation: input === null ? 'clear_seat_cap' : 'set_seat_cap', consumerId },
  });
  void announceOrgChange(orgId, 'seat_caps');
  return { ok: true, walletId: pool.id, caps: await capsOnWallet(pool.id) };
}

/** Donate from the caller's own balance to the drive's wallet (WAL-4); the donation shell re-checks visibility. */
export async function donateToDrive(
  userId: string,
  driveId: string,
  input: { amountCents: number; idempotencyKey: string },
  credential: WalletCredential,
  hooks: WalletWriteHooks = {},
): Promise<{ ok: true; legId: string | null; amountCents: number; paidDebtCents: number; duplicate: boolean } | WalletServiceError> {
  const refused = refuseCredential(credential, 'donate');
  if (refused) return refused;
  const access = await walletAccess(userId, driveId, credential);
  if (!access.ok) return access;
  const denied = requireAction(access, 'donate') ?? (await requireOrgActiveForWrite(access));
  if (denied) return denied;
  const target = await driveWalletRow(db, driveId);
  if (!target) return { ok: false, status: 404, code: 'no_wallet', message: 'This drive has no wallet' };

  await hooks.afterAccess?.();
  const outcome = await donateToDriveWallet({
    donorUserId: userId,
    targetWalletId: target.id,
    amountCents: input.amountCents,
    donationId: input.idempotencyKey,
    // Re-checked under the drive row's lock inside the donation's transaction (see lockDriveOrgStanding).
    expectedDrive: { driveId, orgId: access.standing.orgId },
    afterDriveLock: hooks.afterDriveLock,
  });
  if (outcome.kind === 'donated') {
    await recordOrgWalletEvent(access.standing, userId, 'org.wallet.donated', { amountCents: outcome.amountCents, paidDebtCents: outcome.paidDebtCents, legId: outcome.legId });
    void announceDriveWalletChange(driveId, 'balance');
    return { ok: true, legId: outcome.legId, amountCents: outcome.amountCents, paidDebtCents: outcome.paidDebtCents, duplicate: false };
  }
  if (outcome.kind === 'duplicate') return { ok: true, legId: outcome.legId, amountCents: input.amountCents, paidDebtCents: 0, duplicate: true };
  switch (outcome.reason) {
    case 'insufficient_funds':
      return { ok: false, status: 402, code: outcome.reason, message: 'Your balance cannot cover this donation' };
    case 'drive_moved':
      return driveMoved();
    case 'donations_disabled':
      return { ok: false, status: 409, code: outcome.reason, message: 'This drive does not accept donations' };
    case 'billing_disabled':
      return { ok: false, status: 409, code: outcome.reason, message: 'Billing is not enabled on this deployment' };
    case 'cannot_see_drive':
    case 'wallet_not_found':
      return notFound();
    default:
      return { ok: false, status: 400, code: outcome.reason, message: 'This donation cannot be made' };
  }
}

// ---------------------------------------------------------------------------
// Settings › Usage › Wallets (UI-10): what I spend from, what I fund, my default
// ---------------------------------------------------------------------------

/**
 * Every amount is cents of credit value with its credit count beside it (`…Credits`, the money
 * model's formatter), so a client displays credits without converting (MON-5).
 */
export interface MyWallets {
  personal: { walletId: string; remainingCents: number; remainingCredits: string; defaultSpendSource: SpendSourceKind | null };
  /** Drive wallets of drives I can open: the consumer amount only (SPEND-9), by drive name. */
  driveWallets: { driveId: string; driveName: string | null; walletId: string; status: string; remainingCents: number; remainingCredits: string }[];
  /** A seat on each org I belong to: my own cap only, never the pool (SPEND-9), by org name. */
  seats: { orgId: string; orgName: string | null; walletId: string }[];
  /** What I fund: drive wallets my personal wallet parents, pools I administer (SPEND-10), my donations. */
  funds: {
    driveWallets: { driveId: string; driveName: string | null; walletId: string; status: string; remainingCents: number; remainingCredits: string }[];
    pools: { orgId: string; orgName: string | null; walletId: string; availableCents: number; unallocatedCents: number; availableCredits: string; unallocatedCredits: string }[];
    donations: {
      walletId: string;
      driveId: string | null;
      driveName: string | null;
      originalCents: number;
      originalCredits: string;
      remainingCents: number;
      remainingCredits: string;
      createdAt: string;
    }[];
  };
}

export async function listMyWallets(userId: string, credential: WalletCredential): Promise<MyWallets> {
  const personalId = await ensurePersonalRootWalletId(db, userId);
  const [personal] = await db
    .select({ monthlyRemainingCents: wallets.monthlyRemainingCents, topupRemainingCents: wallets.topupRemainingCents, debtCents: wallets.debtCents, defaultSpendSource: wallets.defaultSpendSource })
    .from(wallets)
    .where(eq(wallets.id, personalId));
  const personalRemaining = Math.max(0, (personal?.monthlyRemainingCents ?? 0) + (personal?.topupRemainingCents ?? 0) - (personal?.debtCents ?? 0));
  const result: MyWallets = {
    personal: {
      walletId: personalId,
      remainingCents: personalRemaining,
      remainingCredits: formatCreditCount(personalRemaining),
      defaultSpendSource: personal?.defaultSpendSource ?? null,
    },
    driveWallets: [],
    seats: [],
    funds: { driveWallets: [], pools: [], donations: [] },
  };

  const donations = await db
    .select({ walletId: walletFundingLegs.walletId, subjectId: wallets.subjectId, originalCents: walletFundingLegs.originalCents, remainingCents: walletFundingLegs.remainingCents, createdAt: walletFundingLegs.createdAt })
    .from(walletFundingLegs)
    .innerJoin(wallets, eq(wallets.id, walletFundingLegs.walletId))
    .where(and(eq(walletFundingLegs.funderUserId, userId), eq(walletFundingLegs.funderKind, 'donation')))
    .limit(500);
  const donationDriveNames = await driveNamesById(donations.flatMap((d) => (d.subjectId ? [d.subjectId] : [])));
  result.funds.donations = donations.map((d) => ({
    walletId: d.walletId,
    driveId: d.subjectId,
    driveName: d.subjectId ? donationDriveNames.get(d.subjectId) ?? null : null,
    originalCents: d.originalCents,
    originalCredits: formatCreditCount(d.originalCents),
    remainingCents: d.remainingCents,
    remainingCredits: formatCreditCount(d.remainingCents),
    createdAt: d.createdAt.toISOString(),
  }));

  if (!ORGS_ENABLED) return result;

  // The drives this person can open, through the one access model; nothing else is listed.
  const driveIds = await getDriveIdsForUser(userId);
  if (driveIds.length > 0) {
    const rows = await db
      .select({ id: wallets.id, subjectId: wallets.subjectId, parentWalletId: wallets.parentWalletId, status: wallets.status, monthlyAllowanceCents: wallets.monthlyAllowanceCents, spentCents: wallets.spentCents, topupRemainingCents: wallets.topupRemainingCents, debtCents: wallets.debtCents })
      .from(wallets)
      .where(and(eq(wallets.subjectType, 'drive'), inArray(wallets.subjectId, driveIds)))
      .limit(1000);
    const driveNames = await driveNamesById(rows.flatMap((r) => (r.subjectId ? [r.subjectId] : [])));
    for (const row of rows) {
      if (!row.subjectId) continue;
      const remaining = walletRemainingCents(row);
      const entry = { driveId: row.subjectId, driveName: driveNames.get(row.subjectId) ?? null, walletId: row.id, status: displayedWalletStatus(row), remainingCents: remaining, remainingCredits: formatCreditCount(remaining) };
      result.driveWallets.push(entry);
      // The funder sees the balance of what they fund (UI-10), as its consumers do.
      if (row.parentWalletId === personalId) result.funds.driveWallets.push(entry);
    }
  }

  const memberships = await db
    .select({ orgId: orgMembers.orgId, role: orgMembers.role })
    .from(orgMembers)
    .where(eq(orgMembers.userId, userId))
    .limit(200);
  const orgNames = await orgNamesById(memberships.map((m) => m.orgId));
  for (const m of memberships) {
    const pool = await orgPoolRow(db, m.orgId);
    if (!pool) continue;
    const orgName = orgNames.get(m.orgId) ?? null;
    result.seats.push({ orgId: m.orgId, orgName, walletId: pool.id });
    if (credential === 'session' && (m.role === 'OWNER' || m.role === 'ADMIN')) {
      const facts = await poolFacts(m.orgId);
      if (facts) {
        const unallocatedCents = facts.availableCents - facts.outstandingChildAllocationsCents;
        result.funds.pools.push({
          orgId: m.orgId,
          orgName,
          walletId: facts.walletId,
          availableCents: facts.availableCents,
          unallocatedCents,
          availableCredits: formatCreditCount(facts.availableCents),
          unallocatedCredits: formatCreditCount(unallocatedCents),
        });
      }
    }
  }
  return result;
}

/** Set (or clear, with null) the person's own default source (SPEND-3, UI-10). */
export async function setPersonalDefaultSource(
  userId: string,
  source: SpendSourceKindValue | null,
  credential: WalletCredential,
): Promise<{ ok: true; defaultSpendSource: SpendSourceKind | null } | WalletServiceError> {
  const refused = refuseCredential(credential, 'set_default_source');
  if (refused) return refused;
  const walletId = await ensurePersonalRootWalletId(db, userId);
  await db.update(wallets).set({ defaultSpendSource: source }).where(and(eq(wallets.id, walletId), personalRootWalletOf(userId)));
  return { ok: true, defaultSpendSource: source };
}

// ---------------------------------------------------------------------------
// "Always my own credits" (SPEND-5)
// ---------------------------------------------------------------------------

/** The person's two switches as the gate reads them: global, and for `driveId`. */
export async function getAlwaysOwnCredits(
  userId: string,
  driveId: string | null,
): Promise<{ ok: true; alwaysOwnCredits: boolean; alwaysOwnCreditsInDrive: boolean }> {
  const [root] = await db.select({ on: wallets.alwaysOwnCredits }).from(wallets).where(personalRootWalletOf(userId)).limit(1);
  const [inDrive] = driveId
    ? await db
        .select({ userId: driveSpendOverrides.userId })
        .from(driveSpendOverrides)
        .where(and(eq(driveSpendOverrides.userId, userId), eq(driveSpendOverrides.driveId, driveId)))
        .limit(1)
    : [];
  return { ok: true, alwaysOwnCredits: root?.on ?? false, alwaysOwnCreditsInDrive: inDrive !== undefined };
}

/**
 * Turn "Always my own credits" on or off (SPEND-5): the one global switch (`driveId` null, on
 * the person's own root wallet) or the switch for one drive. It only ever narrows what a call
 * spends, but a per-drive switch is still set only for a drive the person can open (the
 * permissions module decides), so the table never names a drive to someone outside it.
 * Session only ([D-OW-26]): a token cannot change what an account spends from.
 */
export async function setAlwaysOwnCredits(
  userId: string,
  input: { driveId: string | null; enabled: boolean },
  credential: WalletCredential,
): Promise<{ ok: true; driveId: string | null; enabled: boolean } | WalletServiceError> {
  const refused = refuseCredential(credential, 'set_spend_override');
  if (refused) return refused;
  if (input.driveId === null) {
    const walletId = await ensurePersonalRootWalletId(db, userId);
    await db.update(wallets).set({ alwaysOwnCredits: input.enabled }).where(and(eq(wallets.id, walletId), personalRootWalletOf(userId)));
    return { ok: true, driveId: null, enabled: input.enabled };
  }
  if (!(await getUserDriveAccess(userId, input.driveId))) return notFound();
  if (input.enabled) {
    await db.insert(driveSpendOverrides).values({ userId, driveId: input.driveId }).onConflictDoNothing();
  } else {
    await db.delete(driveSpendOverrides).where(and(eq(driveSpendOverrides.userId, userId), eq(driveSpendOverrides.driveId, input.driveId)));
  }
  return { ok: true, driveId: input.driveId, enabled: input.enabled };
}

// ---------------------------------------------------------------------------
// Per-conversation source (SPEND-2, SPEND-3)
// ---------------------------------------------------------------------------

export interface ConversationSpendRead {
  ok: true;
  conversationId: string;
  driveId: string | null;
  chosenWalletId: string | null;
  /** What this person may pick here, by wallet. */
  options: SpendChoice[];
  /** What the next call would spend, as the gate would decide it now (the chip and strip). */
  resolved: CallSpendDecision;
}

/**
 * The caller's own conversation and the drive of its session (SPEND-7), resolved on the
 * server: a drive conversation's drive, a page conversation's page's drive. A global
 * conversation has no drive of its own — the assistant spends in whatever drive the person is
 * in — so `globalDriveId` (the drive the person is choosing for) is used for it, and only as
 * the context the options are listed in: the options are opened by the permissions module, so
 * a drive the person cannot open offers nothing but their own credits, and the gate re-resolves
 * the stored wallet against the real session drive on every call.
 */
async function ownConversation(userId: string, conversationId: string, globalDriveId: string | null) {
  const [row] = await db
    .select({ id: conversations.id, chosenWalletId: conversations.chosenWalletId, type: conversations.type, contextId: conversations.contextId })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .limit(1);
  if (!row) return null;
  let sessionDriveId: string | null = null;
  if (row.type === 'drive') sessionDriveId = row.contextId;
  else if (row.type === 'page' && row.contextId) {
    const [page] = await db.select({ driveId: pages.driveId }).from(pages).where(eq(pages.id, row.contextId)).limit(1);
    sessionDriveId = page?.driveId ?? null;
  } else if (row.type === 'global') sessionDriveId = globalDriveId;
  return { id: row.id, chosenWalletId: row.chosenWalletId, sessionDriveId };
}

/**
 * The conversation's source as the person will see it before sending (SPEND-2): the stored
 * choice, the options, and the gate's own decision for a zero-cost preview (nothing reserved,
 * no refusal logged). `globalDriveId` is read only for a global conversation (see
 * ownConversation).
 *
 * For a GLOBAL conversation the preview is only as good as the drive the client names: the
 * turn itself spends in a drive only when the server resolved it from a contextRef, and a
 * legacy request without one spends personal credits and reads no stored choice (#2726). A
 * client must therefore preview with the same drive its turns will carry in their contextRef.
 */
export async function getConversationSpend(userId: string, conversationId: string, globalDriveId: string | null = null): Promise<ConversationSpendRead | WalletServiceError> {
  const conversation = await ownConversation(userId, conversationId, globalDriveId);
  if (!conversation) return notFound('Conversation not found');
  const { sessionDriveId } = conversation;
  const [user] = await db.select({ tier: users.subscriptionTier }).from(users).where(eq(users.id, userId)).limit(1);
  const options = await listSpendChoices(userId, sessionDriveId);
  const resolved = await resolveCallSpend({
    userId,
    consumerTier: toSubscriptionTier(user?.tier),
    target: conversationSpend(sessionDriveId, conversationId),
    reservationCents: 0,
    recordRefusal: false,
  });
  return { ok: true, conversationId, driveId: sessionDriveId, chosenWalletId: conversation.chosenWalletId, options, resolved };
}

/**
 * Choose (or clear, with null) the wallet a conversation spends from (SPEND-3). The ONLY
 * writer of conversations.chosenWalletId: a turn never changes it. The wallet must be one of
 * this person's options in the conversation's drive now; the gate re-resolves it on every call
 * anyway, and refuses it if it stops being one.
 */
export async function setConversationSpend(
  userId: string,
  conversationId: string,
  walletId: string | null,
  credential: WalletCredential,
  globalDriveId: string | null = null,
): Promise<ConversationSpendRead | WalletServiceError> {
  const refused = refuseCredential(credential, 'set_conversation_source');
  if (refused) return refused;
  const conversation = await ownConversation(userId, conversationId, globalDriveId);
  if (!conversation) return notFound('Conversation not found');
  if (walletId !== null) {
    const options = await listSpendChoices(userId, conversation.sessionDriveId);
    if (!options.some((o) => o.walletId === walletId)) {
      return { ok: false, status: 400, code: 'wallet_not_available', message: 'That wallet is not one you can spend from in this conversation' };
    }
  }
  await db
    .update(conversations)
    .set({ chosenWalletId: walletId })
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)));
  return getConversationSpend(userId, conversationId, globalDriveId);
}
