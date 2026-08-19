/**
 * Default (real) IO composition for the orphan-teardown reconcile cron — binds
 * `reconcileOrphanSprites` (`@pagespace/lib/services/sandbox/
 * sprite-orphan-reconcile`) to the real `agent_workspaces` table and the
 * `machine_sprite_reclaims` outbox (the FK-less table stays under its
 * pre-Phase-8 physical name — see that table's own doc comment).
 *
 * Two sources, per `sprite-orphan-reconcile.ts`'s module doc:
 *
 *   (A) `machine_sprite_reclaims` — the outbox. Pointers rescued by an
 *       AFTER-DELETE trigger as a Sprite-holding row was destroyed: an
 *       `agent_workspaces` row (or anything it cascades from — its
 *       `ownerId`/`driveId`/`envId` FKs), or a `drive_envs` row that still
 *       believed it held a live Sprite. No row, nothing to restore: kill.
 *
 *   (B) HOLDER rows whose teardown was REQUESTED but never confirmed — a kill
 *       that failed, or a process that died mid-teardown. Both Sprite-holder
 *       tables qualify and both are enumerated here:
 *
 *         - `agent_workspaces` (`endAgentSession` stamps the intent BEFORE it
 *           kills). The row survives on purpose — it is re-provisionable
 *           identity.
 *         - `drive_envs` (`deleteDriveEnv` and `rebuildDriveEnv` stamp it the
 *           same way, and both ABORT rather than proceed when the kill cannot
 *           be confirmed, which is precisely how a surviving row comes to point
 *           at a live VM nobody is retrying). An env row surviving its machine
 *           is the normal state of an environment, not an anomaly.
 *
 *       Release is a STAMP for both, via each store's own `stampSpriteTornDown`
 *       CAS, never a delete.
 *
 * THREE queries, one per source, each capped independently — see
 * `MAX_CANDIDATES_PER_TABLE`.
 */

import { and, asc, eq, isNotNull, isNull, sql } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { agentWorkspaces } from '@pagespace/db/schema/agent-workspaces';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { machineSpriteReclaims } from '@pagespace/db/schema/machine-sprite-reclaims';
import type { ReconcileOrphanSpritesDeps, SpriteOrphanRow } from '@pagespace/lib/services/sandbox/sprite-orphan-reconcile';
import { SandboxSpriteReplacedError } from '@pagespace/lib/services/sandbox/sandbox-host';
import { getAgentSessionStore } from './agent-workspaces-runtime';
import { getSandboxHost } from './sandbox-host-runtime';
import { getDriveEnvStore } from '@/lib/drive-envs/drive-envs-runtime';
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
    // allSettled, not all: the three candidate sources are INDEPENDENT (the
    // FK-less reclaim outbox, and each holder table's rows carrying a teardown
    // intent). A failure reading one must not stop the others' Sprites from
    // being reclaimed — otherwise a single degraded query parks every reclaim
    // until it recovers, and those are billing VMs nobody is using.
    const [reclaimResult, sessionResult, envResult] = await Promise.allSettled([
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
          workspaceId: agentWorkspaces.id,
          sandboxId: agentWorkspaces.sandboxId,
          spriteInstanceId: agentWorkspaces.spriteInstanceId,
          teardownRequestedAt: agentWorkspaces.teardownRequestedAt,
        })
        .from(agentWorkspaces)
        .where(
          and(
            // The intent that licenses a kill at all — an idle-but-live
            // session is NOT a candidate (see the pure core's module doc on
            // why the intent stamp is the whole safety story).
            isNotNull(agentWorkspaces.teardownRequestedAt),
            // "Still believed live" — an already-confirmed-torn-down row has
            // nothing left to reclaim.
            isNull(agentWorkspaces.spriteTornDownAt),
            isNotNull(agentWorkspaces.sandboxId),
          ),
        )
        .orderBy(asc(agentWorkspaces.teardownRequestedAt))
        .limit(LOOKAHEAD),
      db
        .select({
          envId: driveEnvs.id,
          sandboxId: driveEnvs.sandboxId,
          spriteInstanceId: driveEnvs.spriteInstanceId,
          teardownRequestedAt: driveEnvs.teardownRequestedAt,
        })
        .from(driveEnvs)
        .where(
          and(
            // The same three predicates as the session source, on the same
            // three columns — which is the point: an env is a Sprite holder,
            // not a second kind of thing to reclaim.
            //
            // `drive_envs_live_sprite_idx` covers only TWO of them: it is
            // partial on `sandboxId IS NOT NULL AND spriteTornDownAt IS NULL`
            // and keyed on those same columns, so it narrows the scan to rows
            // that still believe they hold a live Sprite — the permanent
            // majority-eliminator, since never-provisioned envs fall outside it
            // forever. The `teardownRequestedAt` filter and the ordering below
            // are NOT served by it and are applied on top. That is fine at this
            // table's size (rows matching the partial predicate are the envs
            // with machines, not all envs); if it ever stops being fine, the
            // fix is to add `teardownRequestedAt` to the index, not to change
            // this query.
            isNotNull(driveEnvs.teardownRequestedAt),
            isNull(driveEnvs.spriteTornDownAt),
            isNotNull(driveEnvs.sandboxId),
          ),
        )
        .orderBy(asc(driveEnvs.teardownRequestedAt))
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
        'Orphan reconcile: session-row listing failed; continuing with the other sources',
        sessionResult.reason instanceof Error ? sessionResult.reason : new Error(String(sessionResult.reason)),
      );
    }
    if (envResult.status === 'rejected') {
      loggers.ai.error(
        'Orphan reconcile: drive-env listing failed; continuing with the other sources',
        envResult.reason instanceof Error ? envResult.reason : new Error(String(envResult.reason)),
      );
    }
    const reclaimRows = reclaimResult.status === 'fulfilled' ? reclaimResult.value : [];
    const sessionRows = sessionResult.status === 'fulfilled' ? sessionResult.value : [];
    const envRows = envResult.status === 'fulfilled' ? envResult.value : [];

    return {
      rows: [
        ...reclaimRows.slice(0, MAX_CANDIDATES_PER_TABLE).map((row): SpriteOrphanRow => ({ kind: 'reclaim', ...row })),
        ...sessionRows
          .slice(0, MAX_CANDIDATES_PER_TABLE)
          // The query's isNotNull(sandboxId)/isNotNull(teardownRequestedAt) guarantee
          // this at the SQL level; the filter narrows the type for the mapper below.
          .flatMap((row): SpriteOrphanRow[] =>
            row.sandboxId
              ? [{ kind: 'agent-session', workspaceId: row.workspaceId, sandboxId: row.sandboxId, spriteInstanceId: row.spriteInstanceId }]
              : [],
          ),
        ...envRows
          .slice(0, MAX_CANDIDATES_PER_TABLE)
          // Same narrowing as above: SQL already guarantees a non-null
          // sandboxId, the filter tells the type system so.
          .flatMap((row): SpriteOrphanRow[] =>
            row.sandboxId
              ? [{ kind: 'drive-env', envId: row.envId, sandboxId: row.sandboxId, spriteInstanceId: row.spriteInstanceId }]
              : [],
          ),
      ],
      capped:
        reclaimRows.length > MAX_CANDIDATES_PER_TABLE ||
        sessionRows.length > MAX_CANDIDATES_PER_TABLE ||
        envRows.length > MAX_CANDIDATES_PER_TABLE,
      // A source we could not read at all. Distinct from `capped`: this run did
      // not merely leave a backlog, it never saw part of the field.
      incomplete:
        reclaimResult.status === 'rejected' ||
        sessionResult.status === 'rejected' ||
        envResult.status === 'rejected',
    };
  },

  async isTeardownStillRequested(row) {
    // Dispatch on the row's kind — the ONE place this cron knows there are two
    // holder tables. The question and its answer are identical either way:
    // does this row still carry an unconfirmed teardown intent?
    if (row.kind === 'drive-env') {
      const env = await (await getDriveEnvStore()).findById(row.envId);
      return env !== null && env.teardownRequestedAt !== null && env.spriteTornDownAt === null;
    }
    const store = await getAgentSessionStore();
    const session = await store.findById(row.workspaceId);
    return session !== null && session.teardownRequestedAt !== null && session.spriteTornDownAt === null;
  },

  async killSprite({ sandboxId, spriteInstanceId }) {
    try {
      const host = await getSandboxHost();
      // Idempotent: an already-destroyed Sprite is a successful kill.
      await host.kill({ sandboxId, expectedInstanceId: spriteInstanceId ?? undefined });
      return { ok: true };
    } catch (error) {
      // A DIFFERENT VM holds this name now — our target is already gone, but
      // what that MEANS depends on which row this is (#2254), and this binding
      // doesn't know that — the pure module does (`row.kind`). Report the
      // replacement rather than collapsing it to success here: for a session
      // row that reads as "confirmed gone" (its own identity CAS protects a
      // live replacement), but for a `reclaim` row — whose outbox entry is the
      // LAST pointer to whatever VM exists under this name — treating it as
      // success would delete the only pointer to a Sprite still alive under
      // `actualInstanceId`.
      if (error instanceof SandboxSpriteReplacedError) {
        return { ok: 'replaced', actualInstanceId: error.actualInstanceId };
      }
      return { ok: false, error };
    }
  },

  async markHolderTornDown(row) {
    const { sandboxId, spriteInstanceId } = row;
    // CAS on the INSTANCE (each store's own contract) — a concurrent
    // re-provision's live replacement must never be marked dead. Note the
    // stamp is `spriteTornDownAt` alone for BOTH kinds: an env has no
    // `endedAt` column, and a session ending is not what this cron witnessed.
    const stamps = { spriteTornDownAt: new Date() };
    if (row.kind === 'drive-env') {
      const envStore = await getDriveEnvStore();
      return envStore.stampSpriteTornDown({ envId: row.envId, sandboxId, spriteInstanceId, stamps });
    }
    const store = await getAgentSessionStore();
    return store.stampSpriteTornDown({ workspaceId: row.workspaceId, sandboxId, spriteInstanceId, stamps });
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

  async chaseReclaimInstance({ sandboxId, actualInstanceId }) {
    // Reuses the store's own upsert rather than a second write path — its
    // `ON CONFLICT DO UPDATE ... COALESCE` is exactly the trigger-mirroring
    // chase this needs, and the row already exists (we are reconciling it), so
    // this always takes the UPDATE branch.
    const store = await getAgentSessionStore();
    await store.enqueueReclaim({ sandboxId, spriteInstanceId: actualInstanceId });
  },
};
