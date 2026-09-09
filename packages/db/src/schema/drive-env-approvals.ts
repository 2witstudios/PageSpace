import { pgTable, text, timestamp, integer, index, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { users } from './auth';
import { driveEnvs, sqlStringList } from './drive-envs';

/**
 * The server's MIRROR of a local environment's durable approvals (GA wave 3,
 * leaf 5) — for visibility and revocation, never for allow.
 *
 * The approvals themselves live on the machine, in
 * `~/.pagespace/env-approvals.json`, written by the daemon's own `remember()`
 * after an owner's click was byte-compared against the request the machine
 * froze (GA wave 2). THAT FILE IS AUTHORITATIVE FOR ALLOW. Nothing the server
 * holds can widen what runs: the codec has no frame that adds an approval,
 * and the invariants test pins it. So what is this table?
 *
 * 1. **What the owner can SEE.** An approval made in the chat was, until now,
 *    invisible in the product — the only record was a file on the laptop. A
 *    row is written here at the moment the server re-issues the grant the
 *    click answered and the machine runs it (`outcome: 'allowed'`), so the
 *    account page can list "what my machines will run without asking".
 *    Approvals made at the TERMINAL prompt are not mirrored (the server never
 *    sees them); the page says so.
 * 2. **A revoke that could not reach the machine.** Wave 2's DELETE answers
 *    `409 no_live_socket` when the machine is away and `202 unacknowledged`
 *    when it did not sign an ack in time — and the machine keeps the approval
 *    until it reconnects. `revokedAt` records the owner's decision;
 *    `revokeAcknowledgedAt` records the machine's SIGNED ack
 *    (`approval_revoke_result`). A row with the first and not the second is a
 *    revoke owed to the machine: on the daemon's next `hello` the server
 *    REPLAYS every such revoke, and holds every grant for that env until the
 *    replay has run. The row is stamped acknowledged only on the signed ack.
 *
 * `id` IS the approval id the machine keyed the approval on (the challenge id
 * of the click), so a revoke names the same thing on both sides. `envId`
 * cascades with the env; `userId` (the principal the approval is for) is SET
 * NULL on erasure. `summary` is the request the click approved, rendered by
 * the server for a person — never output.
 *
 * **GDPR.** Art 15: exported whole under `localEnvironmentApprovals`
 * (`collectUserLocalEnvApprovals`): a row is the subject's if they clicked it
 * (`userId`) OR it stands on a machine they own (`drive_env_local.ownerId`),
 * revoked and expired rows included. Art 17: `userId` SET NULL on erasure; the
 * row goes with its env.
 */
export const DRIVE_ENV_APPROVAL_SCOPES = ['session', '30d', 'until_revoked'] as const;

export const driveEnvApprovals = pgTable('drive_env_approvals', {
  /** The approval id — the challenge id the click answered; what the machine's file and a revoke both name. */
  id: text('id').primaryKey(),

  envId: text('envId')
    .notNull()
    .references(() => driveEnvs.id, { onDelete: 'cascade' }),

  /** The principal the approval is for (`DurableApproval.userId` on the machine). SET NULL on erasure. */
  userId: text('userId').references(() => users.id, { onDelete: 'set null' }),

  /** The grant op the approval covers. */
  op: text('op').notNull(),

  /** The request the click approved, as a person reads it. Bounded by the writer. */
  summary: text('summary').notNull(),

  /** The owner's choice on the card. `once` is never durable and never mirrored. */
  scope: text('scope').notNull(),

  /**
   * For a `session`-scoped row: the daemon process (its attested hello epoch)
   * that holds it. The machine forgets session approvals when that process
   * exits, so a hello from a DIFFERENT epoch expires every session row of
   * this env (`expiresAt = now`) — the mirror never outlives what it mirrors
   * (Codex P2 #7, review round 1). NULL for durable scopes.
   */
  daemonEpoch: text('daemonEpoch'),

  createdAt: timestamp('createdAt', { mode: 'date' }).notNull(),
  /** `null` = until revoked. Mirrors `approvalExpiry(scope, createdAt)` on the machine. */
  expiresAt: timestamp('expiresAt', { mode: 'date' }),

  /** The OWNER's (or a drive admin's) revoke decision. Set on the DELETE whatever the machine said. */
  revokedAt: timestamp('revokedAt', { mode: 'date' }),
  /** Who revoked. */
  revokedBy: text('revokedBy'),
  /** The machine's SIGNED `approval_revoke_result`: set ONLY on the ack. `revokedAt` without this = a revoke owed to the machine. */
  revokeAcknowledgedAt: timestamp('revokeAcknowledgedAt', { mode: 'date' }),
  /** How many rows the machine said it deleted, from the signed ack. */
  revokeRemoved: integer('revokeRemoved'),
}, (table) => ({
  /** The account and env listings. */
  envIdx: index('drive_env_approvals_env_idx').on(table.envId, table.createdAt),
  userIdx: index('drive_env_approvals_user_idx').on(table.userId, table.createdAt),
  /** The closed scope set — `once` cannot be stored, by construction. */
  scopeCheck: check('drive_env_approvals_scope_check', sql`${table.scope} IN (${sqlStringList(DRIVE_ENV_APPROVAL_SCOPES)})`),
  /** An ack without a revoke decision is impossible: the machine only acks what the server asked. */
  ackNeedsRevokeCheck: check('drive_env_approvals_ack_needs_revoke_check', sql`${table.revokeAcknowledgedAt} IS NULL OR ${table.revokedAt} IS NOT NULL`),
}));

export const driveEnvApprovalsRelations = relations(driveEnvApprovals, ({ one }) => ({
  env: one(driveEnvs, {
    fields: [driveEnvApprovals.envId],
    references: [driveEnvs.id],
  }),
  user: one(users, {
    fields: [driveEnvApprovals.userId],
    references: [users.id],
  }),
}));

export type DriveEnvApproval = typeof driveEnvApprovals.$inferSelect;
export type NewDriveEnvApproval = typeof driveEnvApprovals.$inferInsert;
