import { pgTable, text, timestamp, bigint, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { drives } from './core';

/**
 * Drive Environments — deliberate, PERSISTENT per-drive machines.
 *
 * A session (`agent_workspaces`) is an EPHEMERAL working context: it owns a
 * Sprite keyed to its own id, and closing it takes the filesystem with it.
 * That is the right default and it stays the default. What it cannot express
 * is an environment you *return to* — so an env is the second thing: a named,
 * drive-owned machine that outlives every session run inside it.
 *
 * **An env is a DRIVE entity, not a page.** It is deliberately NOT a revival
 * of the deleted MACHINE page type: an env has no tree position, no
 * permissions of its own, and no content. `createdBy` is AUDIT ONLY — it
 * records who asked for the env and nothing else. The env belongs to the
 * drive, which is also who pays for it (attribution resolves to the drive
 * owner, never to the creator), so a creator leaving the drive must not
 * strand or re-bill a machine the drive still uses. Hence `set null` on that
 * FK and `cascade` on `driveId`.
 *
 * **A Sprite belongs to exactly ONE row.** This is the invariant the whole
 * env/session split rests on. An env-bound session carries `envId` and NO
 * Sprite columns (CHECK-enforced on `agent_workspaces`, the same shape
 * `agent_workspace_shells` already uses by having no Sprite columns at all),
 * so "ending an env session must not kill the env" is STRUCTURAL rather than
 * a flag someone has to remember to read: the end planner sees `sandboxId IS
 * NULL` and stamps `endedAt`, killing nothing. There is no owner-of-sprite
 * boolean and no special-cased teardown CAS, because there is nothing to
 * disambiguate.
 *
 * **There is NO KIND COLUMN, and that is a decision rather than an omission.**
 * An earlier cut of this table carried a `drive_env_kind` enum
 * (`dev|staging|deploy`) plus a CHECK partitioning Sprite pointers by it.
 * Both are gone. dev / staging / prod are USE CASES a user expresses by
 * NAMING an env, not types the schema needs to know — an enum would have
 * forced every new use case through a migration and an `ALTER TYPE`, to buy
 * nothing the name does not already say.
 *
 * The corollary matters more: **every env is Sprite-backed, uniformly.** There
 * is no substrate to derive, no `substrateForBoxKind`-style mapping, and no
 * branch in the provisioner. When the Fly serving tier arrives it attaches as
 * a `published_apps.envId` hosting row pointing AT an env; it never puts Fly
 * pointers on this row. So the Sprite columns below are unconditional, the
 * reclaim trigger needs no `WHEN kind = ...` guard, and `machine_sprite_reclaims`
 * is the only outbox this table can ever feed.
 *
 * **No stored status.** Derived the way `workspace-status.ts` derives a
 * session's, from the pointer columns below. Status is a reading of the
 * pointers, and a cached reading of a pointer is a lie waiting for a crash.
 *
 * **Names address here, deliberately.** `(driveId, name)` is UNIQUE — a
 * documented exception to the repo's "ids address, names label" rule (see
 * `agent_workspaces.name`, which carries no uniqueness at all). An env is a
 * deliberate target that humans and pipelines name out loud ("promote to
 * staging"), so two envs called `staging` in one drive is an ambiguity the
 * product cannot resolve. With the kind enum gone the name is also the ONLY
 * thing distinguishing one env's role from another's, which makes its
 * uniqueness load-bearing rather than merely tidy. Ids remain the wire
 * address everywhere else.
 */
export const driveEnvs = pgTable('drive_envs', {
  /**
   * The env's own identity — the API address, and the fold input for the
   * Sprite key it is provisioned under (`deriveDriveEnvSpriteKey`, namespace
   * `drive-env-sprite:v1`, name prefix `pgs-env-`; that helper lands with the
   * Phase 0 lifecycle work and is not in this PR). Client-generated cuid2,
   * same as every other row here.
   */
  id: text('id').primaryKey().$defaultFn(() => createId()),

  /**
   * The owning drive. NOT NULL and cascading — unlike a session, an env has no
   * user-scoped form: there is no "global assistant env", because an env
   * exists to be shared by a drive's members. Deleting the drive takes its
   * envs with it, and the reclaim trigger rescues each Sprite pointer on the
   * way out.
   */
  driveId: text('driveId')
    .notNull()
    .references(() => drives.id, { onDelete: 'cascade' }),

  /**
   * Unique within the drive — the deliberate naming exception, and now the
   * only expression of an env's ROLE (`dev`, `staging`, `prod`, or anything
   * else a team finds useful). See the table docblock.
   */
  name: text('name').notNull(),

  /**
   * AUDIT ONLY: who created the env. `set null` because the env is
   * DRIVE-owned — the creator leaving must neither delete a machine the drive
   * still uses nor leave a dangling id behind. Nothing resolves payment,
   * permission or lifecycle through this column; all three go through
   * `driveId`.
   */
  createdBy: text('createdBy').references(() => users.id, { onDelete: 'set null' }),

  // ---------------------------------------------------------------------------
  // Sprite identity, mirroring `agent_workspaces` column for column. All
  // NULLABLE for the same reason: the row exists from the moment the env is
  // created, which is BEFORE any Sprite (envs provision lazily, on the first
  // session that runs inside one), and a torn-down env clears back toward this
  // state while KEEPING its row — an env survives its machine, which is the
  // entire point of an env.
  //
  // Unconditional: every env is Sprite-backed. Nothing here is gated on a
  // kind, because there is no kind.
  // ---------------------------------------------------------------------------

  /** Opaque HMAC name this env's Sprite is provisioned under — distinct per env, stable across a replacement (what an identity CAS needs). NULL until first provisioned. */
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

  /** Proof of the egress lockdown confirmed for THIS env's VM, handed back on the next provision. NULL when unproven. */
  egressPolicyToken: text('egressPolicyToken'),

  /** Durable teardown INTENT — recorded BEFORE the kill so a crash mid-teardown is still reclaimable. NULL = nobody has asked for this Sprite to die. */
  teardownRequestedAt: timestamp('teardownRequestedAt', { mode: 'date' }),

  /** When this row's `sandboxId` Sprite was CONFIRMED destroyed. NULL = we believe a live Sprite exists under `sandboxId`. */
  spriteTornDownAt: timestamp('spriteTornDownAt', { mode: 'date' }),

  // ---------------------------------------------------------------------------
  // Storage attribution — identical in shape to `agent_workspaces` so the one
  // DI'd reconcile (`sandbox-storage-reconcile.ts`) can read both row sources.
  // An env IS the billed persistence unit; attribution resolves to the drive
  // owner with no fallback (a drive mid-delete simply skips the cycle).
  // ---------------------------------------------------------------------------

  /** Watermark for the storage reconcile — bill only the elapsed window, then advance, so overlapping runs never double-bill. Defaults to now() so a row never bills retroactively. */
  storageLastBilledAt: timestamp('storageLastBilledAt', { mode: 'date' }).defaultNow().notNull(),
  /** Measured used BYTES on this env's filesystem, captured while it is already awake — never by waking a hibernating Sprite. NULL = never measured. */
  storageMeasuredBytes: bigint('storageMeasuredBytes', { mode: 'number' }),
  /** When `storageMeasuredBytes` was captured — drives the measurement throttle and the reconcile's staleness signal. NULL alongside NULL bytes = never measured. */
  storageMeasuredAt: timestamp('storageMeasuredAt', { mode: 'date' }),

  /** Last time a session in this env did anything the sandbox cared about. NULL = nothing since creation. Reported, never acted on — an env is persistent, so idleness must not destroy it. */
  lastActiveAt: timestamp('lastActiveAt', { mode: 'date' }),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => ({
  driveIdIdx: index('drive_envs_drive_id_idx').on(table.driveId),

  /** The naming exception, enforced. See the table docblock for why an env is addressed by name. */
  driveNameUnique: uniqueIndex('drive_envs_drive_name_idx').on(table.driveId, table.name),

  /**
   * The same "still believed live" slice the session table indexes, scanned by
   * the same crons (`sandbox-storage-billing.ts`,
   * `workspace-orphan-reconcile-runtime.ts`) once envs are folded into their
   * row sources. Partial, because never-provisioned envs are permanently
   * outside the predicate and would otherwise be scanned forever.
   */
  liveSpriteIdx: index('drive_envs_live_sprite_idx')
    .on(table.sandboxId, table.spriteTornDownAt)
    .where(sql`${table.sandboxId} IS NOT NULL AND ${table.spriteTornDownAt} IS NULL`),
}));

export const driveEnvsRelations = relations(driveEnvs, ({ one }) => ({
  drive: one(drives, {
    fields: [driveEnvs.driveId],
    references: [drives.id],
  }),
  // `createdBy` only. There is deliberately NO `sessions: many(agentWorkspaces)`
  // here: declaring it would make this module import `agent-workspaces.ts`,
  // which already imports this one for its `envId` FK. The session side owns
  // that edge (`agentWorkspacesRelations.env`), which is also where the FK
  // lives — one direction, no cycle.
  creator: one(users, {
    fields: [driveEnvs.createdBy],
    references: [users.id],
  }),
}));

export type DriveEnv = typeof driveEnvs.$inferSelect;
export type NewDriveEnv = typeof driveEnvs.$inferInsert;
