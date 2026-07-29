/**
 * Default (real) IO composition for the orphan-teardown reconcile cron, agent-
 * sessions half (Phase 7, Dev → Agents billing/storage re-point) — binds
 * `reconcileOrphanSprites` (from `@pagespace/lib/services/sandbox/
 * sprite-orphan-reconcile`, the sandbox-layer successor described in that
 * module's own doc) to the real `agent_sessions` table and the shared
 * `machine_sprite_reclaims` outbox. Mirrors
 * `machine-orphan-reconcile-runtime.ts`'s composition pattern for the legacy
 * machine-tree world — this is its `agent_sessions` twin, run ALONGSIDE it
 * (not instead of it) by the cron route: the outbox is genuinely SHARED (one
 * AFTER-DELETE trigger on `agent_sessions`, reusing the machine-tree world's
 * `enqueue_sprite_reclaim()` per the design), so both reconcilers draining it
 * in the same tick is safe (`killSprite`/outbox release are idempotent — a row
 * either reconciler already claimed simply finds nothing left to release) even
 * though it is mildly redundant. The old machine-tree reconciler keeps running
 * unchanged until the Phase 8 teardown deletes the tables it enumerates.
 *
 * Two sources, per `sprite-orphan-reconcile.ts`'s module doc:
 *
 *   (A) `machine_sprite_reclaims` — the outbox. Pointers rescued by the
 *       AFTER-DELETE trigger as an `agent_sessions` row (or anything it
 *       cascades from — its `conversationId`/`ownerId`/`agentPageId` FKs) was
 *       destroyed. No row, nothing to restore: kill.
 *
 *   (B) `agent_sessions` rows whose teardown was REQUESTED (`endAgentSession`
 *       stamps this BEFORE it kills) but never confirmed — a kill that failed,
 *       or a process that died mid-teardown. The row survives on purpose (it
 *       is re-provisionable identity), so release here is a STAMP via the
 *       store's own `stampSpriteTornDown` CAS, never a delete.
 */

import { and, asc, eq, isNotNull, isNull, sql } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { agentSessions } from '@pagespace/db/schema/agent-sessions';
import { machineSpriteReclaims } from '@pagespace/db/schema/machine-sprite-reclaims';
import type { ReconcileOrphanSpritesDeps, SpriteOrphanRow } from '@pagespace/lib/services/sandbox/sprite-orphan-reconcile';
import { MachineSpriteReplacedError } from '@pagespace/lib/services/sandbox/machine-host';
import { MAX_CANDIDATES_PER_TABLE } from '@/lib/machines/machine-orphan-reconcile-runtime';
import { getAgentSessionStore, getMachineHost } from './agent-sessions-runtime';

/** One row more than the cap, purely to learn whether a backlog remains beyond it — mirrors the legacy runtime's own lookahead. */
const LOOKAHEAD = MAX_CANDIDATES_PER_TABLE + 1;

export const defaultReconcileAgentSessionOrphanSpritesDeps: ReconcileOrphanSpritesDeps = {
  async listOrphanCandidates() {
    const [reclaimRows, sessionRows] = await Promise.all([
      db
        .select({
          sandboxId: machineSpriteReclaims.sandboxId,
          spriteInstanceId: machineSpriteReclaims.spriteInstanceId,
        })
        .from(machineSpriteReclaims)
        .orderBy(asc(machineSpriteReclaims.recordedAt))
        .limit(LOOKAHEAD),
      db
        .select({
          sessionId: agentSessions.conversationId,
          sandboxId: agentSessions.sandboxId,
          spriteInstanceId: agentSessions.spriteInstanceId,
          teardownRequestedAt: agentSessions.teardownRequestedAt,
        })
        .from(agentSessions)
        .where(
          and(
            // The intent that licenses a kill at all — an idle-but-live
            // session is NOT a candidate (see the pure core's module doc on
            // why the intent stamp is the whole safety story).
            isNotNull(agentSessions.teardownRequestedAt),
            // "Still believed live" — an already-confirmed-torn-down row has
            // nothing left to reclaim.
            isNull(agentSessions.spriteTornDownAt),
            isNotNull(agentSessions.sandboxId),
          ),
        )
        .orderBy(asc(agentSessions.teardownRequestedAt))
        .limit(LOOKAHEAD),
    ]);

    return {
      rows: [
        ...reclaimRows.slice(0, MAX_CANDIDATES_PER_TABLE).map((row): SpriteOrphanRow => ({ kind: 'reclaim', ...row })),
        ...sessionRows
          .slice(0, MAX_CANDIDATES_PER_TABLE)
          // The query's isNotNull(sandboxId)/isNotNull(teardownRequestedAt) guarantee
          // this at the SQL level; the filter narrows the type for the mapper below.
          .flatMap((row): SpriteOrphanRow[] =>
            row.sandboxId
              ? [{ kind: 'agent-session', sessionId: row.sessionId, sandboxId: row.sandboxId, spriteInstanceId: row.spriteInstanceId }]
              : [],
          ),
      ],
      capped: reclaimRows.length > MAX_CANDIDATES_PER_TABLE || sessionRows.length > MAX_CANDIDATES_PER_TABLE,
    };
  },

  async isTeardownStillRequested(sessionId) {
    const store = await getAgentSessionStore();
    const session = await store.findById(sessionId);
    return session !== null && session.teardownRequestedAt !== null && session.spriteTornDownAt === null;
  },

  async killSprite({ sandboxId, spriteInstanceId }) {
    try {
      const host = await getMachineHost();
      // Idempotent: an already-destroyed Sprite is a successful kill.
      await host.kill({ machineId: sandboxId, expectedInstanceId: spriteInstanceId ?? undefined });
      return { ok: true };
    } catch (error) {
      // A DIFFERENT VM holds this name now — our target is already gone,
      // exactly the outcome we wanted. The newcomer has its OWN fresh
      // tracking row, so releasing ours never orphans it.
      if (error instanceof MachineSpriteReplacedError) return { ok: true };
      return { ok: false, error };
    }
  },

  async markSessionTornDown({ sessionId, sandboxId, spriteInstanceId }) {
    const store = await getAgentSessionStore();
    // CAS on the INSTANCE (store's own contract) — a concurrent re-provision's
    // live replacement must never be marked dead.
    return store.stampSpriteTornDown({
      sessionId,
      sandboxId,
      spriteInstanceId,
      stamps: { spriteTornDownAt: new Date() },
    });
  },

  async releaseReclaim(sandboxId) {
    await db.delete(machineSpriteReclaims).where(eq(machineSpriteReclaims.sandboxId, sandboxId));
  },

  async noteReclaimFailure({ sandboxId, error }) {
    await db
      .update(machineSpriteReclaims)
      .set({
        attempts: sql`${machineSpriteReclaims.attempts} + 1`,
        lastAttemptAt: new Date(),
        lastError: error instanceof Error ? error.message : String(error),
      })
      .where(eq(machineSpriteReclaims.sandboxId, sandboxId));
  },
};
