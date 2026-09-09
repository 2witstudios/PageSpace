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
import { and, eq, eqOrIsNull, isDistinctFrom, isNotNull, lt, or, sql } from '@pagespace/db/operators';
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
   * about the sprite and a user action changes none of them.
   *
   * UNCONDITIONAL, deliberately — no compare-and-set, no instance guard. This
   * records the user's OWN intent, which is the newest fact by definition; a
   * CAS here would let a detection frame refuse a person's Stop, inverting the
   * rule the rest of this file exists to uphold. An instance guard would be
   * inert as well as harmful: a stop written onto a stale row is already
   * ignored by the planner and rendered `stale`, while requiring the live
   * instance would mean an un-attachable sprite could no longer accept a Stop
   * at all. The guard that belongs here is the one on `upsert`, which replaces
   * a whole row.
   *
   * Resolves the row AS WRITTEN (the same slice `findByHolder` returns, so the caller can
   * plan from it without a second read), or `null` when the holder has no
   * row (nothing to switch off) — a caller never reports "switched off" for
   * a preview that does not exist.
   */
  setStoppedByUser(holder: DevPreviewHolderRef, at: Date | null): Promise<DevPreviewRecord | null>;
  /**
   * Record a person's consent to SHARE exactly `port` on the holder's row,
   * and clear any stop intent — agreeing to share something is asking for it
   * to be on, and leaving it off would answer a click with silence.
   *
   * Resolves the row AS WRITTEN, or `null` when the holder has no row, the
   * row no longer targets `port`, or it belongs to a different sprite
   * INSTANCE than the one the decision was made against. That second case is the point: the port is
   * echoed back from the UI, and the write is filtered on it, so approval
   * cannot drift onto a dev server that moved between the render and the
   * click. The caller answers a null with a conflict, never with success.
   */
  approvePort(holder: DevPreviewHolderRef, input: { port: number; spriteInstanceId: string; at: Date; byUserId: string }): Promise<DevPreviewRecord | null>;
  /**
   * A person PICKED `port` from the ports pane: make it the target, record
   * consent for it, PIN it, and clear any stop — in ONE statement.
   *
   * `approvePort` cannot express this. It is a filtered UPDATE on
   * `targetPort = port`, and the whole point of a pick is naming a port the
   * row does NOT currently target — usually with no row at all, since a
   * server the watch channel cannot see was never detected. Nor can it be
   * done in two steps (planner upsert, then approve): the planner's upsert
   * refuses to write approval, so the row would land carrying the OLD port's
   * consent and `isPreviewShareable` would send it straight back to
   * `await-approval`.
   *
   * Insert-or-update by holder, guarded on `spriteInstanceId` the way
   * `approvePort` is: the instance is echoed from the render, and a pick made
   * against a sandbox that has since been rebuilt must not select the
   * replacement VM's server of the same number. Resolves the row AS WRITTEN,
   * or `null` when a row exists for a DIFFERENT instance (the caller answers
   * `instance-changed`). A missing row is not a refusal — it is the common
   * case — so it is created.
   *
   * `relayServiceName` is left as it was: the planner decides the relay, and
   * this write must not claim one exists. Row-first ordering still holds —
   * the relay work that follows reads this row under the same lock.
   */
  selectPort(holder: DevPreviewHolderRef, input: { port: number; spriteInstanceId: string; sandboxId: string; at: Date; byUserId: string }): Promise<DevPreviewRecord | null>;
  /**
   * Holders whose STOP intent has outlived its relay for longer than
   * `staleAfterMs` — the backstop sweep's candidate list
   * (`dev-preview-reconcile.ts`). Oldest first and capped, so one tick is
   * bounded; the age bound keeps the sweep off rows a live path is still
   * working through.
   */
  findStoppedWithRelay(input: { staleAfterMs: number; limit: number; now: Date }): Promise<Array<{ holder: DevPreviewHolderRef; sandboxId: string }>>;
  /**
   * Re-stamp `updatedAt` on the holder's row, changing nothing else.
   *
   * The sweep needs this because a successful stop WRITES NOTHING — stopping
   * a relay is a service call, and the row already says what the user wants.
   * Without a stamp, a converged row keeps matching
   * {@link DevPreviewStore.findStoppedWithRelay} forever with a permanently
   * old `updatedAt`, and since that query is ordered oldest-first and capped,
   * fifty long-dead rows would occupy every batch and a preview stopped a
   * minute ago would never be reached. Stamping is the backoff: a row the
   * sweep has looked at drops out of the window for `staleAfterMs`.
   */
  markSwept(holder: DevPreviewHolderRef): Promise<void>;
  /**
   * Record that a relay named on the row has been STOPPED: clear
   * `relayServiceName`, and only while the row still names that relay and
   * still carries the stop intent the caller acted on.
   *
   * This is what makes the sweep's candidate window DRAIN. Stopping a relay
   * is a service call that writes nothing, so without it a stopped row keeps
   * naming a relay that is no longer running and re-enters the window every
   * `staleAfterMs` for the life of the record — sixty stopped previews would
   * burn the whole batch on rows with nothing left to do. Clearing the name
   * is also simply true: the row no longer describes anything serving.
   *
   * Nothing else changes shape. A stopped row renders `stopped` before the
   * relay is consulted at all, and a later resume plans from the LIVE service
   * read rather than this column, so it still restarts the same relay.
   */
  markRelayStopped(input: { holder: DevPreviewHolderRef; relayServiceName: string }): Promise<void>;
}

/**
 * The `DevPreviewRow` slice, as columns. Written once: a new field on the row
 * would otherwise need three coordinated edits (the read, and each of the two
 * `returning` clauses), and missing one fails only at runtime, for only that
 * one operation.
 */
const rowColumns = {
  id: devPreviewServices.id,
  spriteInstanceId: devPreviewServices.spriteInstanceId,
  sandboxId: devPreviewServices.sandboxId,
  targetPort: devPreviewServices.targetPort,
  relayServiceName: devPreviewServices.relayServiceName,
  detectedAt: devPreviewServices.detectedAt,
  stoppedByUserAt: devPreviewServices.stoppedByUserAt,
  approvedPort: devPreviewServices.approvedPort,
  approvedAt: devPreviewServices.approvedAt,
  selectedByUserAt: devPreviewServices.selectedByUserAt,
} as const;

function holderColumn(holder: DevPreviewHolderRef) {
  return holder.kind === 'workspace' ? devPreviewServices.workspaceId : devPreviewServices.envId;
}

export function createDbDevPreviewStore(): DevPreviewStore {
  return {
    async findByHolder(holder) {
      const [row] = await db
        .select(rowColumns)
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
        // A brand-new row is a brand-new sprite instance: nothing is approved
        // on it yet, and a detection is not consent.
        approvedPort: null,
        approvedAt: null,
        // Nor is a detection a PICK: only the ports pane pins a target.
        selectedByUserAt: null,
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
            // THE APPROVAL COLUMNS ARE NOT THE PLANNER'S TO WRITE. Only a
            // person grants consent — through `approvePort` (agreeing to what
            // detection found) or `selectPort` (naming a port by hand) — so a
            // detection frame must not
            // carry a value it read moments ago — a user's Share landing in
            // between would be silently wiped, and the stop guard above does
            // not cover these columns. Expressed as SQL over the STORED row
            // rather than a read-modify-write, so there is no window at all.
            //
            // The one thing a detection does decide is that a REBUILD clears
            // consent: a replacement VM inherits nothing, this table's
            // standing rule. Attribution is cleared with it, so the row never
            // credits a consent that no longer exists.
            approvedPort: sql`CASE WHEN ${devPreviewServices.spriteInstanceId} = ${sql.param(intent.spriteInstanceId, devPreviewServices.spriteInstanceId)} THEN ${devPreviewServices.approvedPort} ELSE NULL END`,
            approvedAt: sql`CASE WHEN ${devPreviewServices.spriteInstanceId} = ${sql.param(intent.spriteInstanceId, devPreviewServices.spriteInstanceId)} THEN ${devPreviewServices.approvedAt} ELSE NULL END`,
            approvedByUserId: sql`CASE WHEN ${devPreviewServices.spriteInstanceId} = ${sql.param(intent.spriteInstanceId, devPreviewServices.spriteInstanceId)} THEN ${devPreviewServices.approvedByUserId} ELSE NULL END`,
            // THE PIN SURVIVES ONLY ITS OWN PORT. A planner upsert that lands
            // here is detection moving the target, and a pin vouches for the
            // port a person named — never for whatever replaced it. So it is
            // kept when the stored target is the one being written (a
            // reconcile of the same port, which must not quietly unpin it)
            // and cleared otherwise, including on a rebuild. Same
            // SQL-over-the-stored-row shape as the approval columns, for the
            // same reason: no read-modify-write window a user's pick could
            // fall into.
            selectedByUserAt: sql`CASE WHEN ${devPreviewServices.spriteInstanceId} = ${sql.param(intent.spriteInstanceId, devPreviewServices.spriteInstanceId)} AND ${devPreviewServices.targetPort} = ${sql.param(intent.targetPort, devPreviewServices.targetPort)} THEN ${devPreviewServices.selectedByUserAt} ELSE NULL END`,
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
        .returning(rowColumns);
      return row ?? null;
    },

    async selectPort(holder, { port, spriteInstanceId, sandboxId, at, byUserId }) {
      const column = holderColumn(holder);
      // No `id`: the schema's `$defaultFn` mints one, exactly as `upsert` relies on.
      const values = {
        workspaceId: holder.kind === 'workspace' ? holder.id : null,
        envId: holder.kind === 'env' ? holder.id : null,
        spriteInstanceId,
        sandboxId,
        targetPort: port,
        // Not this write's to claim; the planner reconciles it next, under
        // the same lock, from the row this returns.
        relayServiceName: null,
        detectedAt: at,
        stoppedByUserAt: null,
        approvedPort: port,
        approvedAt: at,
        approvedByUserId: byUserId,
        selectedByUserAt: at,
      };
      const [written] = await db
        .insert(devPreviewServices)
        .values(values)
        .onConflictDoUpdate({
          target: column,
          targetWhere: sql`${column} IS NOT NULL`,
          // THE INSTANCE GUARD, as the predicate: a pick echoes the instance it
          // was made against, and a row for a different one is a rebuilt
          // sandbox — the pick must not land on it. Same shape as
          // `approvePort`, expressed here as "update only when it matches".
          setWhere: sql`${devPreviewServices.spriteInstanceId} = ${sql.param(spriteInstanceId, devPreviewServices.spriteInstanceId)}`,
          set: {
            targetPort: port,
            // A pick names a port the row may not have known. A relay pointed
            // at the previous target is the planner's to replace, and it does
            // so from this row — but the NAME must survive here so the planner
            // can see there is one to take down (`replace-relay` needs it).
            detectedAt: at,
            stoppedByUserAt: null,
            approvedPort: port,
            approvedAt: at,
            approvedByUserId: byUserId,
            selectedByUserAt: at,
            updatedAt: sql`(now() at time zone 'utc')`,
          },
        })
        .returning(rowColumns);
      // `returning` yields nothing when `setWhere` refused — the instance
      // guard held. Distinguish that from "no row" for the caller's sentence.
      return written ?? null;
    },
    async findStoppedWithRelay({ staleAfterMs, limit, now }) {
      const rows = await db
        .select({
          workspaceId: devPreviewServices.workspaceId,
          envId: devPreviewServices.envId,
          sandboxId: devPreviewServices.sandboxId,
        })
        .from(devPreviewServices)
        .where(
          and(
            isNotNull(devPreviewServices.stoppedByUserAt),
            isNotNull(devPreviewServices.relayServiceName),
            // `sql.param` routes the Date through the column's encoder; a bare
            // interpolation would land offset against a wall-clock column.
            lt(devPreviewServices.updatedAt, sql.param(new Date(now.getTime() - staleAfterMs), devPreviewServices.updatedAt)),
          ),
        )
        .orderBy(devPreviewServices.updatedAt)
        .limit(limit);
      return rows.map((row) => ({
        holder: (row.workspaceId !== null ? { kind: 'workspace', id: row.workspaceId } : { kind: 'env', id: row.envId as string }) as DevPreviewHolderRef,
        sandboxId: row.sandboxId,
      }));
    },

    async markSwept(holder) {
      // `updatedAt` has an `$onUpdate` hook, but an UPDATE with no changed
      // columns still needs a SET clause — so set it explicitly, in the same
      // UTC wall-clock terms every other write here uses.
      await db
        .update(devPreviewServices)
        .set({ updatedAt: sql`(now() at time zone 'utc')` })
        .where(eq(holderColumn(holder), holder.id));
    },

    async markRelayStopped({ holder, relayServiceName }) {
      await db
        .update(devPreviewServices)
        .set({ relayServiceName: null, updatedAt: sql`(now() at time zone 'utc')` })
        .where(
          and(
            eq(holderColumn(holder), holder.id),
            // Only the relay we actually stopped, and only while the stop
            // still stands: a resume or a re-point that landed in between
            // owns this column now.
            eq(devPreviewServices.relayServiceName, relayServiceName),
            isNotNull(devPreviewServices.stoppedByUserAt),
          ),
        );
    },

    async approvePort(holder, { port, spriteInstanceId, at, byUserId }) {
      const [row] = await db
        .update(devPreviewServices)
        .set({ approvedPort: port, approvedAt: at, approvedByUserId: byUserId, stoppedByUserAt: null, updatedAt: sql`(now() at time zone 'utc')` })
        // THE ECHOED PORT, enforced in SQL rather than by a read-then-write:
        // the approval lands only while the row still targets the port the
        // user was shown. A dev server that moved between the render and the
        // click therefore cannot be approved by a click meant for the old one.
        // The port AND the INSTANCE, both echoed from what the user was shown.
        // The port stops a consent meant for one server landing on another;
        // the instance stops it landing on another VM. A rebuild replaces the
        // row and can legitimately detect the same port again, so a click made
        // against the old sandbox would otherwise approve the new one — and
        // sharing is exactly the decision that must not be inherited.
        .where(and(
          eq(holderColumn(holder), holder.id),
          eq(devPreviewServices.targetPort, port),
          eq(devPreviewServices.spriteInstanceId, spriteInstanceId),
        ))
        .returning(rowColumns);
      return row ?? null;
    },
  };
}
