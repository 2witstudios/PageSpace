/**
 * Default (real) IO composition for the orphan-teardown reconcile cron — binds
 * `reconcileOrphanSprites` (`@pagespace/lib/services/sandbox/
 * sprite-orphan-reconcile`) to the real `agent_sessions` table and the
 * `machine_sprite_reclaims` outbox (the FK-less table stays under its
 * pre-Phase-8 physical name — see that table's own doc comment).
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
import { SandboxSpriteReplacedError } from '@pagespace/lib/services/sandbox/sandbox-host';
import { getAgentSessionStore, getSandboxHost } from './agent-sessions-runtime';
import { loggers } from '@pagespace/lib/logging/logger-config';

/**
 * Cap on how many candidate rows each source contributes to one reconcile
 * tick — bounds a single run's work regardless of backlog size; a backlog
 * beyond the cap simply drains over successive ticks (see `capped` below).
 */
export const MAX_CANDIDATES_PER_TABLE = 200;

/** One row more than the cap, purely to learn whether a backlog remains beyond it. */
const LOOKAHEAD = MAX_CANDIDATES_PER_TABLE + 1;

export const defaultReconcileAgentSessionOrphanSpritesDeps: ReconcileOrphanSpritesDeps = {
  async listOrphanCandidates() {
    // allSettled, not all: the two candidate sources are INDEPENDENT (the
    // FK-less reclaim outbox, and rows carrying a teardown intent). A failure
    // reading one must not stop the other's Sprites from being reclaimed —
    // otherwise a single degraded query parks every reclaim until it recovers,
    // and those are billing VMs nobody is using.
    const [reclaimResult, sessionResult] = await Promise.allSettled([
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
          sessionId: agentSessions.id,
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

    if (reclaimResult.status === 'rejected') {
      loggers.ai.error(
        'Orphan reconcile: reclaim-outbox listing failed; continuing with session rows only',
        reclaimResult.reason instanceof Error ? reclaimResult.reason : new Error(String(reclaimResult.reason)),
      );
    }
    if (sessionResult.status === 'rejected') {
      loggers.ai.error(
        'Orphan reconcile: session-row listing failed; continuing with reclaim rows only',
        sessionResult.reason instanceof Error ? sessionResult.reason : new Error(String(sessionResult.reason)),
      );
    }
    const reclaimRows = reclaimResult.status === 'fulfilled' ? reclaimResult.value : [];
    const sessionRows = sessionResult.status === 'fulfilled' ? sessionResult.value : [];

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
      // A source we could not read at all. Distinct from `capped`: this run did
      // not merely leave a backlog, it never saw part of the field.
      incomplete: reclaimResult.status === 'rejected' || sessionResult.status === 'rejected',
    };
  },

  async isTeardownStillRequested(sessionId) {
    const store = await getAgentSessionStore();
    const session = await store.findById(sessionId);
    return session !== null && session.teardownRequestedAt !== null && session.spriteTornDownAt === null;
  },

  async killSprite({ sandboxId, spriteInstanceId }) {
    try {
      const host = await getSandboxHost();
      // Idempotent: an already-destroyed Sprite is a successful kill.
      await host.kill({ sandboxId, expectedInstanceId: spriteInstanceId ?? undefined });
      return { ok: true };
    } catch (error) {
      // A DIFFERENT VM holds this name now — our target is already gone,
      // exactly the outcome we wanted. The newcomer has its OWN fresh
      // tracking row, so releasing ours never orphans it.
      if (error instanceof SandboxSpriteReplacedError) return { ok: true };
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
