/**
 * Default (real) IO composition for the storage reconcile cron (Sprites
 * Platform Alignment 6-1) — binds `reconcileSandboxStorage`'s deps seam to the
 * `agent_sessions` table and the credit pipeline. Reads the last PERSISTED
 * measured bytes (never the provisioned cap, never waking a sprite).
 *
 * Narrowed by the Phase 8 teardown: this used to also enumerate FOUR
 * machine-tree row sources (a Machine's own Sprite, every live branch
 * Sprite, every promoted project Sprite, every per-session agent-terminal
 * Sprite) and exposed the opportunistic per-op storage-measurement writers
 * for them (`measureMachineStorageOpportunistically` and its three
 * siblings). Those tables are dropped, and opportunistic measurement was
 * never wired for `agent_sessions` — both die with this sweep. Re-wiring
 * opportunistic measurement for agent-session Sprites is a follow-up, not
 * done here.
 */

import { eq, and, isNotNull, isNull } from '@pagespace/db/operators';
import { db, getAdvisoryLockPool } from '@pagespace/db/db';
import { withAdvisoryLock, type AdvisoryLockPool } from '@pagespace/db/advisory-lock';
import { agentSessions } from '@pagespace/db/schema/agent-sessions';
import { lookupPageOwnerId } from '../../billing/sandbox-payer';
import { MACHINE_MARKUP_BPS } from '../../billing/credit-pricing';
import { AIMonitoring } from '../../monitoring/ai-monitoring';
import {
  reconcileSandboxStorage,
  type ReconcileSandboxStorageDeps,
  type ReconcileSandboxStorageResult,
} from './sandbox-storage-reconcile';

export const defaultReconcileSandboxStorageDeps: ReconcileSandboxStorageDeps = {
  async listAgentSessionSprites() {
    const rows = await db
      .select({
        sessionId: agentSessions.conversationId,
        agentPageId: agentSessions.agentPageId,
        ownerId: agentSessions.ownerId,
        storageLastBilledAt: agentSessions.storageLastBilledAt,
        measuredBytes: agentSessions.storageMeasuredBytes,
        measuredAt: agentSessions.storageMeasuredAt,
        lastActiveAt: agentSessions.lastActiveAt,
      })
      .from(agentSessions)
      .where(and(isNotNull(agentSessions.sandboxId), isNull(agentSessions.spriteTornDownAt)));
    // `lastActiveAt` is nullable on `agent_sessions` ("reported only, never
    // acted on") — a row that has never recorded activity falls back to the
    // epoch, the honest-conservative "not awake" reading.
    return rows.map((row) => ({ ...row, lastActiveAt: row.lastActiveAt ?? new Date(0) }));
  },

  lookupPageOwnerId,

  async chargeStorage({ payerId, pageId, costDollars, gbMonths }) {
    await AIMonitoring.trackUsage({
      userId: payerId,
      provider: 'sprites',
      model: 'terminal-machine-storage',
      source: 'terminal',
      // The ATTRIBUTION page (sandbox-storage-attribution.ts): the session's
      // agent page, when it has one. Undefined for a global-assistant
      // agent-session — there is no page to group it under; `trackUsage`
      // treats a missing `pageId` as unattributed-to-a-page, not an error.
      pageId,
      providerCostDollars: costDollars,
      // Not a wall-clock duration (this is a background storage charge, not a
      // single timed run) — 0 mirrors the shape of every other non-timed
      // usage row while staying a valid non-negative duration.
      duration: 0,
      success: true,
      // No holdId: a background reconcile charge, not gated against a
      // pre-placed hold (mirrors reconcile-ai-cost's settle path).
      costSource: 'list_price',
      // Same 1.5x substrate floor as active-runtime billing (machine-billing.ts),
      // independent of the shared AI MARKUP_BPS default.
      markupBpsOverride: MACHINE_MARKUP_BPS,
      metadata: { type: 'terminal_storage', pageId, gbMonths },
    });
  },

  // The `agent_sessions` Sprite's OWN watermark — directly on the row itself:
  // the design's "per-row watermark" made literal, no separate tracking
  // table.
  async advanceAgentSessionWatermark({ sessionId, billedThrough }) {
    await db
      .update(agentSessions)
      .set({ storageLastBilledAt: billedThrough })
      .where(eq(agentSessions.conversationId, sessionId));
  },

  now: () => new Date(),
};

/**
 * Advisory-lock key for serializing `reconcileSandboxStorage` across EVERY
 * caller — a second web/worker container, or a manual/API trigger, can run
 * the cron route concurrently with no shared state to stop it. The crontab
 * flock (Sprites Platform Alignment, #2032) only guards one container's own
 * scheduled ticks; it does nothing for a second container or an out-of-band
 * invocation. `chargeStorage` and `advanceAgentSessionWatermark` are two
 * separate un-transactioned writes (see sandbox-storage-reconcile.ts's module
 * doc), so two overlapping runs can double-bill the same watermark window.
 * This lock makes every caller overlap-safe, in addition to (not instead of)
 * the flock. Acquired via `withAdvisoryLock` on `getAdvisoryLockPool()`'s
 * dedicated pool — see that pool's doc in `@pagespace/db/db` for why it must
 * stay separate from the main `db` pool `deps` below queries against.
 *
 * The literal value is UNCHANGED from the pre-Phase-8 key (still
 * `reconcile-machine-storage`, not `reconcile-sandbox-storage`) — it is a
 * Postgres advisory-lock name shared across a rolling deploy, and changing it
 * would let an old-code and new-code container run the reconcile
 * concurrently against each other for the length of the rollout.
 */
const RECONCILE_SANDBOX_STORAGE_LOCK_KEY = 'reconcile-machine-storage';

export type ReconcileSandboxStorageRunResult =
  | { outcome: 'lock_busy' }
  | ({ outcome: 'reconciled' } & ReconcileSandboxStorageResult);

/**
 * Serializes `reconcileSandboxStorage` with a Postgres session-level advisory
 * try-lock (see `withAdvisoryLock`): a run that cannot acquire it (another
 * run — any process, any container — already holds it) is a clean no-op and
 * never touches `deps.listAgentSessionSprites`/`chargeStorage`/`advanceAgentSessionWatermark`.
 */
export async function reconcileSandboxStorageSerialized(
  deps: ReconcileSandboxStorageDeps,
  pgPool: AdvisoryLockPool = getAdvisoryLockPool(),
): Promise<ReconcileSandboxStorageRunResult> {
  const locked = await withAdvisoryLock(pgPool, RECONCILE_SANDBOX_STORAGE_LOCK_KEY, () =>
    reconcileSandboxStorage(deps),
  );
  if (locked.outcome === 'lock_busy') {
    return { outcome: 'lock_busy' };
  }
  if (locked.outcome === 'connection_error') {
    // Preserves this caller's existing behavior exactly (previously an unwrapped throw
    // from `withAdvisoryLock` itself): propagate so the cron route's own catch logs it
    // and the next scheduled tick retries. `withAdvisoryLock` resolving this outcome
    // instead of throwing (leaf 5.6/5.7) only removes the AMBIGUITY for callers that
    // need to distinguish it from `fn` throwing — this caller's `fn`
    // (`reconcileSandboxStorage`) already documents that it never throws, so there is
    // no such ambiguity here, and the choice to keep propagating is now explicit at the
    // type level rather than implicit in an uncaught rejection.
    throw locked.error;
  }
  return { outcome: 'reconciled', ...locked.result };
}
