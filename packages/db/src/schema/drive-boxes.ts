import { pgTable, text, timestamp, bigint, index, uniqueIndex, pgEnum, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { drives } from './core';

/**
 * Drive Boxes — deliberate, PERSISTENT per-drive machines.
 *
 * A session (`agent_workspaces`) is an EPHEMERAL working context: it owns a
 * Sprite keyed to its own id, and closing it takes the filesystem with it.
 * That is the right default and it stays the default. What it cannot express
 * is an environment you *return to* — so a box is the second thing: a named,
 * drive-owned machine that outlives every session run inside it.
 *
 * **A box is a DRIVE entity, not a page.** It is deliberately NOT a revival of
 * the deleted MACHINE page type: a box has no tree position, no permissions of
 * its own, and no content. `createdBy` is AUDIT ONLY — it records who asked
 * for the box and nothing else. The box belongs to the drive, which is also
 * who pays for it (attribution resolves to the drive owner, never to the
 * creator), so a creator leaving the drive must not strand or re-bill a
 * machine the drive still uses. Hence `set null` on that FK and `cascade` on
 * `driveId`.
 *
 * **A Sprite belongs to exactly ONE row.** This is the invariant the whole
 * box/session split rests on. A box-bound session carries `boxId` and NO
 * Sprite columns (CHECK-enforced on `agent_workspaces`, the same shape
 * `agent_workspace_shells` already uses by having no Sprite columns at all),
 * so "ending a box session must not kill the box" is STRUCTURAL rather than a
 * flag someone has to remember to read: the end planner sees `sandboxId IS
 * NULL` and stamps `endedAt`, killing nothing. There is no owner-of-sprite
 * boolean and no special-cased teardown CAS, because there is nothing to
 * disambiguate.
 *
 * **Substrate is DERIVED, never stored.** dev/staging boxes run on Sprites
 * (the session tooling already speaks Sprite, and hibernation makes
 * persistence cheap); deploy boxes run on raw Fly Machines. That mapping is
 * `substrateForBoxKind` in `@pagespace/lib/drive-boxes/box-kind` and it is the
 * single source of truth. A stored column would be a second witness that can
 * disagree with `kind`, which is the drift bug this schema's neighbours
 * (`workspaceState`, `conversations.workspaceId`) were built to delete.
 *
 * `drive_boxes_sprite_kind_check` is what makes that derivation load-bearing
 * rather than advisory: a `kind='deploy'` row may hold NO Sprite pointer at
 * all. So this table's AFTER DELETE trigger can only ever hand
 * `machine_sprite_reclaims` a pointer it knows how to kill — a deploy row has
 * none to give it.
 *
 * **The Fly half of that story does not exist yet.** The intended end state is
 * two partitioned outboxes, with Fly app names reaching `app_hosting_reclaims`
 * via the hosting row's own trigger — but that table is introduced by PR #2425
 * (unmerged) and is nowhere in this schema today. Stated plainly because the
 * gap is load-bearing for whoever builds Phase 6: a `kind='deploy'` box
 * currently has NO reclaim path of any kind, and that is safe ONLY because
 * nothing can provision a Fly machine for one yet. Wiring deploy provisioning
 * without also wiring its outbox re-creates the orphan-billing bug
 * `machine_sprite_reclaims` was built to end.
 *
 * **No stored status.** Derived the way `workspace-status.ts` derives a
 * session's, from the pointer columns below. (A deploy box is intended to
 * surface its hosting row's status machine instead — that row arrives with PR
 * #2425 and does not exist yet, so a deploy box has no derivable status today
 * either.) Status is a reading of the pointers, and a cached reading of a
 * pointer is a lie waiting for a crash.
 *
 * **Names address here, deliberately.** `(driveId, name)` is UNIQUE — a
 * documented exception to the repo's "ids address, names label" rule (see
 * `agent_workspaces.name`, which carries no uniqueness at all). A box is a
 * deliberate deploy target that humans and pipelines name out loud ("promote
 * to staging"), so two boxes called `staging` in one drive is an ambiguity the
 * product cannot resolve. Ids remain the wire address everywhere else.
 */
export const driveBoxKind = pgEnum('drive_box_kind', ['dev', 'staging', 'deploy']);

export const driveBoxes = pgTable('drive_boxes', {
  /**
   * The box's own identity — the API address, and the fold input for the
   * Sprite key a dev/staging box will be provisioned under
   * (`deriveDriveBoxSpriteKey`, namespace `drive-box-sprite:v1`, name prefix
   * `pgs-box-`; that helper lands with the Phase 0 lifecycle work and is not
   * in this PR). Client-generated cuid2, same as every other row here.
   */
  id: text('id').primaryKey().$defaultFn(() => createId()),

  /**
   * The owning drive. NOT NULL and cascading — unlike a session, a box has no
   * user-scoped form: there is no "global assistant box", because a box exists
   * to be shared by a drive's members. Deleting the drive takes its boxes with
   * it, and the reclaim trigger rescues each Sprite pointer on the way out.
   */
  driveId: text('driveId')
    .notNull()
    .references(() => drives.id, { onDelete: 'cascade' }),

  /** Unique within the drive — the deliberate naming exception; see the table docblock. */
  name: text('name').notNull(),

  /** Selects the substrate (via `substrateForBoxKind`) and gates the sprite CHECK below. */
  kind: driveBoxKind('kind').notNull(),

  /**
   * AUDIT ONLY: who created the box. `set null` because the box is DRIVE-owned
   * — the creator leaving must neither delete a machine the drive still uses
   * nor leave a dangling id behind. Nothing resolves payment, permission or
   * lifecycle through this column; all three go through `driveId`.
   */
  createdBy: text('createdBy').references(() => users.id, { onDelete: 'set null' }),

  // ---------------------------------------------------------------------------
  // Sprite identity, mirroring `agent_workspaces` column for column. All
  // NULLABLE for the same reason: the row exists from the moment the box is
  // created, which is BEFORE any Sprite (boxes provision lazily, on the first
  // session that runs inside one), and a torn-down box clears back toward this
  // state while KEEPING its row — a box survives its machine, which is the
  // entire point of a box.
  //
  // Held on `kind IN ('dev','staging')` rows only (CHECK below). A deploy
  // box's Fly state is meant to live on its hosting row rather than here —
  // that row ships with PR #2425 and does not exist yet.
  // ---------------------------------------------------------------------------

  /** Opaque HMAC name this box's Sprite is provisioned under — distinct per box, stable across a replacement (what an identity CAS needs). NULL until first provisioned. */
  spriteKey: text('spriteKey'),

  /** The Sprite's NAME (reused across re-creates) — see `spriteInstanceId` for the actual identity. NULL until first provisioned. */
  sandboxId: text('sandboxId'),

  /**
   * The platform's id for the Sprite INSTANCE this row points at. `sandboxId`
   * cannot tell a replacement VM from the one we meant to act on (same name),
   * so every teardown CAS — and the reclaim outbox's ABA guard — keys on this.
   * NULL when the platform reported none.
   */
  spriteInstanceId: text('spriteInstanceId'),

  /** Proof of the egress lockdown confirmed for THIS box's VM, handed back on the next provision. NULL when unproven. */
  egressPolicyToken: text('egressPolicyToken'),

  /** Durable teardown INTENT — recorded BEFORE the kill so a crash mid-teardown is still reclaimable. NULL = nobody has asked for this Sprite to die. */
  teardownRequestedAt: timestamp('teardownRequestedAt', { mode: 'date' }),

  /** When this row's `sandboxId` Sprite was CONFIRMED destroyed. NULL = we believe a live Sprite exists under `sandboxId`. */
  spriteTornDownAt: timestamp('spriteTornDownAt', { mode: 'date' }),

  // ---------------------------------------------------------------------------
  // Storage attribution — identical in shape to `agent_workspaces` so the one
  // DI'd reconcile (`sandbox-storage-reconcile.ts`) can read both row sources.
  // A box IS the billed persistence unit; attribution resolves to the drive
  // owner with no fallback (a drive mid-delete simply skips the cycle).
  // ---------------------------------------------------------------------------

  /** Watermark for the storage reconcile — bill only the elapsed window, then advance, so overlapping runs never double-bill. Defaults to now() so a row never bills retroactively. */
  storageLastBilledAt: timestamp('storageLastBilledAt', { mode: 'date' }).defaultNow().notNull(),
  /** Measured used BYTES on this box's filesystem, captured while it is already awake — never by waking a hibernating Sprite. NULL = never measured. */
  storageMeasuredBytes: bigint('storageMeasuredBytes', { mode: 'number' }),
  /** When `storageMeasuredBytes` was captured — drives the measurement throttle and the reconcile's staleness signal. NULL alongside NULL bytes = never measured. */
  storageMeasuredAt: timestamp('storageMeasuredAt', { mode: 'date' }),

  /** Last time a session in this box did anything the sandbox cared about. NULL = nothing since creation. Reported, never acted on — a box is persistent, so idleness must not destroy it. */
  lastActiveAt: timestamp('lastActiveAt', { mode: 'date' }),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => ({
  driveIdIdx: index('drive_boxes_drive_id_idx').on(table.driveId),

  /** The naming exception, enforced. See the table docblock for why a box is addressed by name. */
  driveNameUnique: uniqueIndex('drive_boxes_drive_name_idx').on(table.driveId, table.name),

  /**
   * The same "still believed live" slice the session table indexes, scanned by
   * the same crons (`sandbox-storage-billing.ts`,
   * `workspace-orphan-reconcile-runtime.ts`) once boxes are folded into their
   * row sources. Partial, because deploy boxes and never-provisioned boxes are
   * permanently outside the predicate and would otherwise be scanned forever.
   */
  liveSpriteIdx: index('drive_boxes_live_sprite_idx')
    .on(table.sandboxId, table.spriteTornDownAt)
    .where(sql`${table.sandboxId} IS NOT NULL AND ${table.spriteTornDownAt} IS NULL`),

  /**
   * Deploy boxes never hold Sprite pointers. This is what keeps the two
   * reclaim outboxes partitioned (see the table docblock): the AFTER DELETE
   * trigger on this table only ever enqueues into `machine_sprite_reclaims`,
   * and this CHECK is the proof that a `kind='deploy'` row can never carry a
   * pointer that would land there.
   *
   * Stated over the three POINTER columns rather than all six. The test is not
   * "is this column Sprite-flavoured" but "can a live VM be reached through
   * it", because reaching one is what orphans it: `sandboxId` addresses the
   * VM, `spriteInstanceId` is the identity every teardown CAS keys on, and
   * `spriteKey` re-derives the name. Those three are exactly what the reclaim
   * outbox stores and what the orphan reconciler kills by.
   *
   * The other three are inert on a deploy row, for two different reasons, and
   * both are worth naming so a later reader does not "helpfully" add them:
   * `teardownRequestedAt` and `spriteTornDownAt` describe the lifecycle of a
   * pointer this constraint has already forbidden, so they can only ever
   * describe nothing. `egressPolicyToken` is NOT a timestamp and not a
   * lifecycle stamp — it is proof that an egress lockdown was confirmed for a
   * VM — but it is still not an address: nothing can be found, billed or
   * destroyed through it, so a stray value is unusable rather than dangerous.
   * Widening the predicate to cover it would buy no reclaim safety and would
   * make the constraint say something other than what it means.
   *
   * Shipped VALID: the table is created empty in the same migration, so there
   * is no legacy corpus to grandfather and nothing for a scan to reject.
   */
  spriteKindCheck: check(
    'drive_boxes_sprite_kind_check',
    sql`${table.kind} IN ('dev', 'staging') OR (${table.sandboxId} IS NULL AND ${table.spriteKey} IS NULL AND ${table.spriteInstanceId} IS NULL)`,
  ),
}));

export const driveBoxesRelations = relations(driveBoxes, ({ one }) => ({
  drive: one(drives, {
    fields: [driveBoxes.driveId],
    references: [drives.id],
  }),
  // `createdBy` only. There is deliberately NO `sessions: many(agentWorkspaces)`
  // here: declaring it would make this module import `agent-workspaces.ts`,
  // which already imports this one for its `boxId` FK. The session side owns
  // that edge (`agentWorkspacesRelations.box`), which is also where the FK
  // lives — one direction, no cycle.
  creator: one(users, {
    fields: [driveBoxes.createdBy],
    references: [users.id],
  }),
}));

export type DriveBox = typeof driveBoxes.$inferSelect;
export type NewDriveBox = typeof driveBoxes.$inferInsert;
