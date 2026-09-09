import { pgTable, text, timestamp, integer, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { driveEnvs, sqlStringList } from './drive-envs';

/**
 * Server-side grant audit for LOCAL environments — the other half of the
 * daemon's `~/.pagespace/env-audit.jsonl` (Local Environments epic, invariant
 * 10: "audit both sides, cross-referenceable by `grantId`"; GA wave 3).
 *
 * Before this table the audit had ONE side. The daemon wrote a JSON line per
 * decision keyed by `grantId`, and `audit-log.ts` in the CLI claimed the server
 * audited by the same id so the two could be joined. The server wrote nothing
 * for a grant it signed — only a security-audit event for a REFUSAL to sign.
 * A layer the product cannot show the user does not exist as a layer, and
 * audit is one of the two layers standing in for a sandbox on this surface
 * ([D-1]). This table is what makes the join claim true: `bridge-client.ts`
 * writes a row at SIGN time and updates it at RESULT time, and a real-Postgres
 * test joins these rows to a daemon JSONL fixture on `grantId`.
 *
 * **Why a dedicated table and not a `security_audit_log` row.** That log is a
 * tamper-evident HASH CHAIN: every row is append-only and folded into the
 * next row's hash. A grant row is written when the server signs and UPDATED
 * when the machine answers (verdict, exit code, result time) — a shape the
 * chain forbids by construction. Two chained rows per grant (one at sign, one
 * at result) would work but would make "what is running right now" a join
 * over the whole log instead of a `resultAt IS NULL` predicate. So this is its
 * own table, in this register beside the chained log, with the same docblock
 * rigour and its own indexes for the two questions the product asks of it:
 * "what has this MACHINE done" (`envId, ts`) and "what has this USER asked
 * machines to do" (`userId, ts`). It is still written by the server only and
 * never by a request body: every column comes from the grant the server
 * signed or the machine-signed result it verified.
 *
 * **The rows and their verdicts.** One row per grant the server SIGNED
 * (`verdict = 'signed'` until the result lands), and one row per grant the
 * server REFUSED to sign (`verdict = 'refused:<reason>'`, the typed reason
 * from `decideSign`). A refusal never mints a grant id (GA wave 1 pinned
 * that), so a refused row carries `grantId = NULL` — the CHECK below keeps
 * "has a grant id" and "was signed" the same fact. At result time the row's
 * verdict becomes the machine's answer: `completed` (an `exec_result` with
 * its `exitCode`, or an fs result), `denied:<reason>` (the daemon's typed
 * `grant_denied` — the owner's policy said no), `ask_pending:<challengeId>`
 * (frozen for the owner's click, GA wave 2), or `failed:<kind>` (timeout,
 * disconnected, unverified result, paused). `resultAt IS NULL` on a signed
 * row is exactly "running now".
 *
 * **The click is audited here too.** A grant re-issued by the owner's click
 * carries `approvalIntent`; its row records the `challengeId` it answered
 * and the `approvalScope` the owner chose, so "who approved this and for how
 * long" is one row away from "what ran".
 *
 * **`summary` is for the activity panel, and it is the ONLY column a person
 * is meant to read.** It is the request as the server sent it, rendered by
 * the server (`exec: sh -c 'git status'` in `/home/o/proj`; `fs_read: /a,
 * /b`), bounded, never the machine's output. It is what the OWNER of the
 * machine sees under "what ran"; the routes that serve it are owner-only
 * ([D-6], invariant 13). `argsHash` is the daemon's join key for the exact
 * bytes; `summary` is the human's.
 *
 * **Least privilege on the row.** `envId` cascades with the env — a deleted
 * environment takes its activity with it, as a deleted env takes its
 * sessions. `userId` is `SET NULL` on erasure (Art 17) so the machine's
 * history survives its requester's deletion as the security log's does.
 * `sessionId` and `conversationId` are plain text: they name principals the
 * daemon's JSONL also names, and an audit row must outlive the session it
 * records.
 */
export const DRIVE_ENV_GRANT_AUDIT_OPS = ['exec', 'fs_read', 'fs_write', 'pty_open'] as const;

/** Longest `summary` stored — a rendering for a panel, not a transcript. */
export const DRIVE_ENV_GRANT_AUDIT_SUMMARY_MAX_CHARS = 512;

export const driveEnvGrantAudit = pgTable('drive_env_grant_audit', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  /** The LOCAL env the grant was for. Cascades with it. */
  envId: text('envId')
    .notNull()
    .references(() => driveEnvs.id, { onDelete: 'cascade' }),

  /**
   * The grant the server minted — the daemon's JSONL key, and the join. NULL
   * on a REFUSED row: a refusal never mints one (the CHECK pins the pairing).
   */
  grantId: text('grantId'),

  /** The acting user (the grant's principal). SET NULL on erasure. */
  userId: text('userId').references(() => users.id, { onDelete: 'set null' }),
  /** The grant's principal, as the daemon's JSONL names it. */
  sessionId: text('sessionId').notNull(),
  conversationId: text('conversationId').notNull(),

  /** The grant op — `exec | fs_read | fs_write | pty_open`, CHECK-closed. */
  op: text('op').notNull(),

  /** `hash(canonicalizeArgs(request.args))` — the same projection the signer put under the signature and the daemon's gate re-derived. */
  argsHash: text('argsHash').notNull(),

  /** The one column a person reads. See the table docblock. */
  summary: text('summary').notNull(),

  /**
   * `signed` → the machine's answer; or `refused:<reason>` for a grant the
   * server would not sign. See the table docblock for the closed vocabulary.
   */
  verdict: text('verdict').notNull(),

  /** The child's exit code for a completed `exec`; NULL otherwise. */
  exitCode: integer('exitCode'),

  /** The owner's click this grant answered (GA wave 2), when it did. */
  challengeId: text('challengeId'),
  approvalScope: text('approvalScope'),

  /** Sign time (or refusal time). The row's ordering key. */
  ts: timestamp('ts', { mode: 'date' }).defaultNow().notNull(),
  /** When the machine's verified answer (or the typed failure) landed. NULL on a signed row = running now. */
  resultAt: timestamp('resultAt', { mode: 'date' }),
}, (table) => ({
  /** "What has this machine done" — the activity panel's read, newest first. */
  envTsIdx: index('drive_env_grant_audit_env_ts_idx').on(table.envId, table.ts),
  /** "What has this user asked machines to do" — the account page's read. */
  userTsIdx: index('drive_env_grant_audit_user_ts_idx').on(table.userId, table.ts),
  /** One row per grant. Partial: refused rows have no grant id. */
  grantIdUnique: uniqueIndex('drive_env_grant_audit_grant_id_unique').on(table.grantId).where(sql`${table.grantId} IS NOT NULL`),
  /** The closed op set, from the exported constant so the two cannot drift. */
  opCheck: check('drive_env_grant_audit_op_check', sql`${table.op} IN (${sqlStringList(DRIVE_ENV_GRANT_AUDIT_OPS)})`),
  /** "Has a grant id" and "was signed" are the same fact: a refused row has none, every other row has one. */
  grantIdRefusedCheck: check(
    'drive_env_grant_audit_grant_id_refused_check',
    sql`(${table.grantId} IS NULL) = (${table.verdict} LIKE 'refused:%')`,
  ),
}));

export const driveEnvGrantAuditRelations = relations(driveEnvGrantAudit, ({ one }) => ({
  env: one(driveEnvs, {
    fields: [driveEnvGrantAudit.envId],
    references: [driveEnvs.id],
  }),
  user: one(users, {
    fields: [driveEnvGrantAudit.userId],
    references: [users.id],
  }),
}));

export type DriveEnvGrantAudit = typeof driveEnvGrantAudit.$inferSelect;
export type NewDriveEnvGrantAudit = typeof driveEnvGrantAudit.$inferInsert;
