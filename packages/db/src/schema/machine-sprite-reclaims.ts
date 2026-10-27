import { pgTable, text, timestamp, integer, index } from 'drizzle-orm/pg-core';

/**
 * Machine Sprite Reclaims — the teardown OUTBOX.
 *
 * A Sprite is a real, billing microVM. The ONLY way to find one is its
 * `sandboxId`, and that id lives in `machine_sessions` / `machine_branches` —
 * both of which FK-cascade off `pages.id` (and off `users.id`). So every path
 * that hard-deletes a page destroys the only pointer to a VM that may still be
 * running: the 30-day GDPR purge, "delete permanently" from the trash, a
 * permanent drive delete, the account-erasure worker, and any path someone adds
 * tomorrow. The VM then bills RAM forever, unreachable from inside the product.
 * We found exactly one of these in production (`pgs-sbx-…`, stuck `running`,
 * unreferenced) and had to kill it by hand.
 *
 * Guarding each delete path was the obvious fix and it is the WRONG one: it is
 * unenforceable (there is always one more path), and it cannot work for erasure —
 * GDPR Art. 17 must not be blocked by a Sprite we failed to kill.
 *
 * So this table inverts the dependency. It holds nothing but a `sandboxId`, and
 * it has NO FOREIGN KEYS — nothing can cascade it away. `AFTER DELETE` triggers
 * on both tracking tables copy the id in here as the row is destroyed (Postgres
 * fires row triggers for rows deleted by a referential CASCADE too, so this
 * captures the id no matter WHICH table's delete started it, including a manual
 * `DELETE FROM pages`). The insert is part of the deleting transaction: either
 * the pointer moves here, or the delete does not commit.
 *
 * The pointer therefore OUTLIVES the resource, which is the invariant that
 * matters. The orphan-reconcile cron
 * (`@pagespace/lib/services/machines/machine-orphan-reconcile`) drains this
 * table with an idempotent kill and removes each row only once the Sprite is
 * CONFIRMED gone — so a failed kill is retried forever rather than forgotten.
 *
 * Because the pointer can no longer be lost, the hard purge needs no guard and
 * no page is ever unpurgeable: erasure proceeds, and the Sprite it orphans is
 * reclaimed within one cron tick.
 */
export const machineSpriteReclaims = pgTable(
  'machine_sprite_reclaims',
  {
    /**
     * The Sprite to destroy. PRIMARY KEY, so the triggers can `ON CONFLICT DO
     * NOTHING`: the same Sprite being enqueued twice (a branch row and a session
     * row that somehow share an id, or a re-delete after a failed kill) is the
     * same single unit of work.
     */
    sandboxId: text('sandboxId').primaryKey(),

    /**
     * The platform's id for the Sprite INSTANCE that was live when this pointer
     * was rescued. The kill is NAME-keyed, and a name is reused across
     * re-creates, so without this we could destroy a REPLACEMENT VM that
     * legitimately took the name later. The reconciler passes it as the kill's
     * identity guard: "kill the VM at this name ONLY if it is still this one".
     * NULL for a legacy row (then the kill falls back to name-only).
     */
    spriteInstanceId: text('spriteInstanceId'),

    /** When the pointer was rescued — i.e. when its tracking row was destroyed. */
    recordedAt: timestamp('recordedAt', { mode: 'date' }).defaultNow().notNull(),

    /** Kill attempts so far. A row with a high count is a Sprite that cannot be killed — a real, billing anomaly worth alerting on. */
    attempts: integer('attempts').default(0).notNull(),

    /** When the last kill was attempted, and why it failed — the health signal for a stuck reclaim. */
    lastAttemptAt: timestamp('lastAttemptAt', { mode: 'date' }),
    lastError: text('lastError'),
  },
  (table) => ({
    // The cron drains oldest-first, so it can be capped without starving a row.
    recordedAtIdx: index('machine_sprite_reclaims_recorded_at_idx').on(table.recordedAt),
  }),
);

export type MachineSpriteReclaim = typeof machineSpriteReclaims.$inferSelect;
export type NewMachineSpriteReclaim = typeof machineSpriteReclaims.$inferInsert;
