/**
 * `dev_preview_services` store — the holder-keyed read and the holder-keyed
 * UPSERT the decision core's row intent asks for.
 *
 * The conflict target is the HOLDER column (each has a partial unique index —
 * see the table docblock), so a re-create on a rebuilt sprite REPLACES the
 * holder's dead-instance row rather than leaving one dead row per rebuild
 * beside it. Every column is written on conflict, `stoppedByUserAt` included:
 * a plan that reaches a write has already proven the stop intent does not
 * apply, and a merge that skipped the column would resurrect a stop from a
 * dead VM (`DevPreviewRowIntent`'s doc).
 *
 * The read returns the structural `DevPreviewRow` slice the core consumes
 * (plus the id), so callers hand the core a plain object and never the
 * Drizzle type.
 *
 * The upsert is a COMPARE-AND-SET on the user's stop intent
 * (`DevPreviewRowIntent.basedOnStoppedByUserAt`): the DO UPDATE fires only
 * while the stored intent still equals the one the plan was made against, so
 * a detection frame that planned before a user's stop can never clear it
 * after. A refused write is not an error — the next reconcile plans afresh
 * from the row that won.
 */

import { db } from '@pagespace/db/db';
import { eq, eqOrIsNull, isDistinctFrom, or, sql } from '@pagespace/db/operators';
import { devPreviewServices } from '@pagespace/db/schema/dev-preview-services';
import type { DevPreviewHolderRef, DevPreviewRow, DevPreviewRowIntent } from './dev-preview-core';

export interface DevPreviewRecord extends DevPreviewRow {
  id: string;
}

export interface DevPreviewStore {
  findByHolder(holder: DevPreviewHolderRef): Promise<DevPreviewRecord | null>;
  /** Resolves `true` when the row was written, `false` when the intent guard refused it (see the module doc). */
  upsert(intent: DevPreviewRowIntent): Promise<boolean>;
  /**
   * Record the user's STOP intent (`at`) or clear it (`null`) on the holder's
   * row — the one column the platform cannot report (an explicit stop lands a
   * service in `failed`, indistinguishable from a crash — spike §4). Writes
   * ONLY that column: the row's instance, target and relay name are facts
   * about the sprite and a user action changes none of them. Resolves the
   * row AS WRITTEN (the same slice `findByHolder` returns, so the caller can
   * plan from it without a second read), or `null` when the holder has no
   * row (nothing to switch off) — a caller never reports "switched off" for
   * a preview that does not exist.
   */
  setStoppedByUser(holder: DevPreviewHolderRef, at: Date | null): Promise<DevPreviewRecord | null>;
}

function holderColumn(holder: DevPreviewHolderRef) {
  return holder.kind === 'workspace' ? devPreviewServices.workspaceId : devPreviewServices.envId;
}

export function createDbDevPreviewStore(): DevPreviewStore {
  return {
    async findByHolder(holder) {
      const [row] = await db
        .select({
          id: devPreviewServices.id,
          spriteInstanceId: devPreviewServices.spriteInstanceId,
          sandboxId: devPreviewServices.sandboxId,
          targetPort: devPreviewServices.targetPort,
          relayServiceName: devPreviewServices.relayServiceName,
          detectedAt: devPreviewServices.detectedAt,
          stoppedByUserAt: devPreviewServices.stoppedByUserAt,
        })
        .from(devPreviewServices)
        .where(eq(holderColumn(holder), holder.id))
        .limit(1);
      return row ?? null;
    },

    async upsert(intent) {
      const column = holderColumn(intent.holder);
      const values = {
        workspaceId: intent.holder.kind === 'workspace' ? intent.holder.id : null,
        envId: intent.holder.kind === 'env' ? intent.holder.id : null,
        spriteInstanceId: intent.spriteInstanceId,
        sandboxId: intent.sandboxId,
        targetPort: intent.targetPort,
        relayServiceName: intent.relayServiceName,
        detectedAt: intent.detectedAt,
        stoppedByUserAt: intent.stoppedByUserAt,
      };
      const written = await db
        .insert(devPreviewServices)
        .values(values)
        .onConflictDoUpdate({
          target: column,
          // Must match the partial index's predicate for Postgres to pick it.
          targetWhere: sql`${column} IS NOT NULL`,
          // THE INTENT GUARD, as one SQL predicate. Update when EITHER:
          //  - the stored row is for a DIFFERENT Sprite instance — it
          //    describes a VM that no longer exists, so a re-create replaces
          //    it wholesale and its stop intent dies with it (the table's
          //    own rule: nothing carries over a rebuild, not even the stop);
          //  - or the stored stop intent on THIS instance is still the one
          //    the plan was made against (`IS NOT DISTINCT FROM`, so NULL
          //    compares equal to NULL). A user's stop that landed after the
          //    plan's read therefore refuses the write instead of being
          //    silently cleared.
          // The repo's own null-safe comparators (`operators.ts`), written for
          // exactly this shape of compare-and-swap on a nullable column —
          // `eqOrIsNull` also routes the Date through the column's encoder,
          // which a bare interpolation would not.
          setWhere: or(
            isDistinctFrom(devPreviewServices.spriteInstanceId, intent.spriteInstanceId),
            eqOrIsNull(devPreviewServices.stoppedByUserAt, intent.basedOnStoppedByUserAt),
          ),
          set: {
            spriteInstanceId: values.spriteInstanceId,
            sandboxId: values.sandboxId,
            targetPort: values.targetPort,
            relayServiceName: values.relayServiceName,
            detectedAt: values.detectedAt,
            stoppedByUserAt: values.stoppedByUserAt,
            // Not `now()`: `updatedAt` is a UTC wall-clock timestamp column and
            // `now()` resolves through the session TZ (see the SQL-now rule).
            updatedAt: sql`(now() at time zone 'utc')`,
          },
        })
        .returning({ id: devPreviewServices.id });
      return written.length > 0;
    },

    async setStoppedByUser(holder, at) {
      const [row] = await db
        .update(devPreviewServices)
        .set({ stoppedByUserAt: at, updatedAt: sql`(now() at time zone 'utc')` })
        .where(eq(holderColumn(holder), holder.id))
        .returning({
          id: devPreviewServices.id,
          spriteInstanceId: devPreviewServices.spriteInstanceId,
          sandboxId: devPreviewServices.sandboxId,
          targetPort: devPreviewServices.targetPort,
          relayServiceName: devPreviewServices.relayServiceName,
          detectedAt: devPreviewServices.detectedAt,
          stoppedByUserAt: devPreviewServices.stoppedByUserAt,
        });
      return row ?? null;
    },
  };
}
