import { pgTable, text, timestamp, bigint, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { pages } from './core';
import { users } from './auth';

/**
 * Machine Sessions
 *
 * The sandboxId↔page link for Machine page execution. A page's warm Fly Sprite
 * is addressed by an opaque HMAC session key (see services/sandbox/machine-session-manager.ts);
 * this table records which `sandboxId` that key resolves to, so returning users
 * reconnect to the same shell/state rather than provisioning a fresh VM each time.
 *
 * One live row per session key (unique) — the key already namespaces by
 * tenant + drive + page. A row is deleted on teardown (idle, session end, crash,
 * failure), so a present row means "this page has a sandbox we believe is live".
 * `lastActiveAt` drives idle reclamation.
 *
 * Resume authorization is NOT encoded here: the lifecycle layer re-runs
 * `canPrincipalEditPage` for the current actor on every request. `userId` is the
 * creating actor, kept for audit only.
 */
export const machineSessions = pgTable('machine_sessions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  // Opaque, unguessable HMAC key — the addressable boundary. Unique: a
  // page resolves to exactly one live Machine sandbox.
  sessionKey: text('sessionKey').notNull().unique(),

  pageId: text('pageId')
    .notNull()
    .references(() => pages.id, { onDelete: 'cascade' }),

  // Creating actor — audit only; resume re-authz is enforced in code per request.
  userId: text('userId')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  // Fly Sprite NAME — our derived session key. NOT an identity: it is reused
  // across re-creates, so a Sprite destroyed and re-provisioned under this same
  // key answers to the same value while being a physically different VM.
  sandboxId: text('sandboxId').notNull(),

  /**
   * The platform's id for the Sprite INSTANCE this row points at — the VM's
   * actual identity (see `SpriteInstanceLike.id`). NULL for rows written before
   * this column existed, or when the platform reported no id.
   *
   * Load-bearing for teardown safety: a kill and a row release must both be able
   * to tell "the VM I meant" from "a replacement that took its name". Comparing
   * `sandboxId` cannot — it is the same string for both — so a re-provision
   * racing a teardown would let us drop the pointer to a LIVE VM (orphaning it) or
   * destroy it outright.
   */
  spriteInstanceId: text('spriteInstanceId'),

  // Proof that a specific egress policy was applied to a specific Sprite INSTANCE
  // — a token over (sprite id, policy hash); see
  // services/sandbox/egress-lockdown.ts. The Sprite's policy file is persistent
  // and survives hibernation, so a hand-back whose token still holds skips
  // re-pushing it — the redundant control-plane round-trip that used to sit on
  // every machine connect and every 60s re-auth tick.
  //
  // Keyed on the sprite INSTANCE id, not on our (reused) session-key name: a
  // Sprite destroyed and re-created under the same name is a different VM, on the
  // platform's default OPEN egress, and must never inherit its predecessor's
  // proof. NULL = unknown (a row predating this column, a lost write, or a
  // platform that reported no id) → the lockdown is applied and recorded on the
  // next hand-back. Fail-closed by construction: an unlocked sandbox is never
  // linked to a row, because the link is written only after the driver confirms
  // the policy.
  egressPolicyToken: text('egressPolicyToken'),

  lastActiveAt: timestamp('lastActiveAt', { mode: 'date' }).defaultNow().notNull(),

  /**
   * When a teardown of this Machine's own Sprite was REQUESTED — i.e.
   * `deleteMachine` ran and meant to destroy it. NULL = nobody has asked for this
   * Sprite to die. (The row itself is DELETED once the kill is confirmed, so a
   * row that still has this set is a teardown that never completed.)
   *
   * This is an INTENT marker, and it is what the orphan reconciler requires
   * before it destroys anything. "The owning page is trashed" is NOT sufficient
   * intent: `pageService.trashPage` (the generic page DELETE, bulk-delete, and
   * folder cascade-trash) trashes a MACHINE page WITHOUT any teardown, and that
   * trash is reversible — a restore is expected to hand the user back a Machine
   * with its filesystem intact. A `host.kill` is an irreversible DESTROY, so a
   * reconciler keyed on `isTrashed` alone would silently wipe the disk of every
   * Machine anyone ever moved to the trash. See `machine-orphan-reconcile.ts`
   * (which does still reclaim a never-torn-down Sprite once its page is past the
   * hard-purge cutoff — at that point the page is being erased, so leaving the
   * VM alive would strand it forever).
   */
  teardownRequestedAt: timestamp('teardownRequestedAt', { mode: 'date' }),

  // Watermark for the idle-storage reconcile cron (Machine Epic 3): the
  // persistent filesystem accrues cost whether the Machine is active or
  // hibernating, so this is billed separately from active-runtime — see
  // packages/lib/src/services/sandbox/machine-storage-reconcile.ts. Each run
  // bills only the elapsed window since this watermark, then advances it, so
  // repeated/overlapping runs never double-bill (idempotent by construction).
  // Defaults to now() so pre-existing rows start accruing from migration time
  // rather than requiring a backfill.
  storageLastBilledAt: timestamp('storageLastBilledAt', { mode: 'date' }).defaultNow().notNull(),

  // Measured persistent-storage usage, in BYTES, captured opportunistically
  // while the machine is already awake for real work (terminal connect, agent
  // run, file browse) — never by waking a paused sprite. The storage reconcile
  // (machine-storage-reconcile.ts) bills these MEASURED bytes, not the
  // provisioned allocation: the platform charges for bytes actually written
  // (TRIM-friendly), not the full volume size (docs.sprites.dev/concepts/lifecycle).
  // NULL = never measured yet → the reconcile bills a conservative 0 floor for
  // that window (it does NOT fall back to the provisioned cap, the old bug).
  storageMeasuredBytes: bigint('storageMeasuredBytes', { mode: 'number' }),
  // When `storageMeasuredBytes` was last captured — drives the measurement
  // throttle (at most one measure per machine per window) and the reconcile's
  // staleness signal. NULL alongside a NULL byte count means never measured.
  storageMeasuredAt: timestamp('storageMeasuredAt', { mode: 'date' }),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => ({
  pageIdIdx: index('machine_sessions_page_id_idx').on(table.pageId),
  lastActiveAtIdx: index('machine_sessions_last_active_at_idx').on(table.lastActiveAt),
}));

export const machineSessionsRelations = relations(machineSessions, ({ one }) => ({
  page: one(pages, {
    fields: [machineSessions.pageId],
    references: [pages.id],
  }),
  user: one(users, {
    fields: [machineSessions.userId],
    references: [users.id],
  }),
}));

export type MachineSession = typeof machineSessions.$inferSelect;
export type NewMachineSession = typeof machineSessions.$inferInsert;
