/**
 * The server side of the local-environment grant audit — the store over
 * `drive_env_grant_audit` (GA wave 3, leaf 1; invariant 10).
 *
 * `EnvBridgeClient.sendGrant` (apps/web) calls this at the two moments a
 * grant has a fact worth keeping: when the server SIGNS (or refuses to sign)
 * and when the machine's VERIFIED answer lands. Each row is keyed by the
 * `grantId` the daemon's own JSONL uses, so the two sides join — see the
 * table docblock for the verdict vocabulary and why this is not a
 * hash-chained security-audit row.
 *
 * Rendering the `summary` lives here too (`summarizeGrantRequest`), so the
 * apps/web client, the activity routes and the tests all read the same
 * sentence for the same request. It is bounded and it never carries output.
 */
import type { GrantRequest } from '../../env-bridge/grant-args';

/** Longest `summary` stored — mirrors `DRIVE_ENV_GRANT_AUDIT_SUMMARY_MAX_CHARS` on the schema (the contract test pins them equal). */
export const GRANT_AUDIT_SUMMARY_MAX_CHARS = 512;

export type GrantAuditOp = 'exec' | 'fs_read' | 'fs_write' | 'pty_open';

export interface DriveEnvGrantAuditRecord {
  id: string;
  envId: string;
  /** NULL on a refused row — a refusal never mints one. */
  grantId: string | null;
  userId: string | null;
  sessionId: string;
  conversationId: string;
  op: GrantAuditOp;
  argsHash: string;
  summary: string;
  verdict: string;
  exitCode: number | null;
  challengeId: string | null;
  approvalScope: string | null;
  ts: Date;
  resultAt: Date | null;
}

/** What the client knows when it signs: the grant's identity and the request it covers. */
export interface GrantAuditSignInput {
  envId: string;
  grantId: string;
  principal: { userId: string; sessionId: string; conversationId: string };
  op: GrantAuditOp;
  argsHash: string;
  summary: string;
  /** The owner's click this grant answers, when it does (GA wave 2). */
  approval?: { challengeId: string; scope: string } | undefined;
  now: Date;
}

/** A refusal to sign: no grant id, the typed reason from `decideSign`. */
export interface GrantAuditRefusalInput {
  envId: string;
  principal: { userId: string; sessionId: string; conversationId: string };
  op: GrantAuditOp;
  argsHash: string;
  summary: string;
  reason: string;
  now: Date;
}

/** The machine's verified answer — or the typed failure that ended the wait. */
export interface GrantAuditResultInput {
  grantId: string;
  /** `completed` | `denied:<reason>` | `ask_pending:<challengeId>` | `failed:<kind>` */
  verdict: string;
  exitCode: number | null;
  now: Date;
}

export interface GrantAuditStore {
  /** A signed grant: one row, verdict `signed`, `resultAt` NULL until the answer. */
  recordSign(input: GrantAuditSignInput): Promise<DriveEnvGrantAuditRecord>;
  /** A refused sign: one row, verdict `refused:<reason>`, no grant id, `resultAt = ts` (nothing will follow). */
  recordRefusal(input: GrantAuditRefusalInput): Promise<DriveEnvGrantAuditRecord>;
  /** The answer, by grant id: ONE update; `null` when no signed row carries the id. */
  recordResult(input: GrantAuditResultInput): Promise<DriveEnvGrantAuditRecord | null>;
  /** The env's rows, newest first, bounded — the activity panel's read. */
  listForEnv(input: { envId: string; limit: number }): Promise<DriveEnvGrantAuditRecord[]>;
  /** Rows for every env a user OWNS, newest first, bounded — the account page's read. Owner, not requester: a machine's activity belongs to its owner. */
  listForOwner(input: { ownerId: string; limit: number }): Promise<DriveEnvGrantAuditRecord[]>;
}

/** The activity panel's page size and the routes' ceiling. */
export const GRANT_AUDIT_LIST_LIMIT = 50;

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * One line a person can read for one request, as the SERVER sent it. Never
 * the output. Quoting is for the eye only — this is not a shell line to run.
 */
export function summarizeGrantRequest(request: GrantRequest): string {
  const quote = (word: string) => (/[\s'"$`\\]/.test(word) ? `'${word.replace(/'/g, "'\\''")}'` : word);
  let line: string;
  switch (request.op) {
    case 'exec': {
      const argv = [request.args.cmd, ...request.args.args].map(quote).join(' ');
      line = request.args.cwd !== null ? `exec: ${argv} in ${request.args.cwd}` : `exec: ${argv}`;
      break;
    }
    case 'fs_read':
      line = `fs_read: ${request.args.paths.join(', ')}`;
      break;
    case 'fs_write':
      line = `fs_write: ${request.args.files.map((file) => file.path).join(', ')}`;
      break;
    case 'pty_open': {
      const argv = [...(request.args.command === null ? [] : [request.args.command]), ...request.args.args].map(quote).join(' ');
      line = argv.length > 0 ? `pty_open: ${argv}` : 'pty_open';
      break;
    }
  }
  return clip(line, GRANT_AUDIT_SUMMARY_MAX_CHARS);
}

/**
 * Production DB-backed implementation. Lazily resolves the db client so a
 * test that injects a fake never loads the DB module graph — the same shape
 * `createDbDriveEnvStore` uses.
 */
export async function createDbGrantAuditStore(): Promise<GrantAuditStore> {
  const [{ db }, { eq, desc, and, isNull }, { driveEnvGrantAudit }, { driveEnvLocal }] = await Promise.all([
    import('@pagespace/db/db'),
    import('@pagespace/db/operators'),
    import('@pagespace/db/schema/drive-env-grant-audit'),
    import('@pagespace/db/schema/drive-env-local'),
  ]);

  const asRecord = (row: typeof driveEnvGrantAudit.$inferSelect): DriveEnvGrantAuditRecord => ({
    id: row.id,
    envId: row.envId,
    grantId: row.grantId,
    userId: row.userId,
    sessionId: row.sessionId,
    conversationId: row.conversationId,
    op: row.op as GrantAuditOp,
    argsHash: row.argsHash,
    summary: row.summary,
    verdict: row.verdict,
    exitCode: row.exitCode,
    challengeId: row.challengeId,
    approvalScope: row.approvalScope,
    ts: row.ts,
    resultAt: row.resultAt,
  });

  return {
    async recordSign(input) {
      const [row] = await db
        .insert(driveEnvGrantAudit)
        .values({
          envId: input.envId,
          grantId: input.grantId,
          userId: input.principal.userId,
          sessionId: input.principal.sessionId,
          conversationId: input.principal.conversationId,
          op: input.op,
          argsHash: input.argsHash,
          summary: clip(input.summary, GRANT_AUDIT_SUMMARY_MAX_CHARS),
          verdict: 'signed',
          exitCode: null,
          challengeId: input.approval?.challengeId ?? null,
          approvalScope: input.approval?.scope ?? null,
          ts: input.now,
          resultAt: null,
        })
        .returning();
      return asRecord(row!);
    },

    async recordRefusal(input) {
      const [row] = await db
        .insert(driveEnvGrantAudit)
        .values({
          envId: input.envId,
          grantId: null,
          userId: input.principal.userId,
          sessionId: input.principal.sessionId,
          conversationId: input.principal.conversationId,
          op: input.op,
          argsHash: input.argsHash,
          summary: clip(input.summary, GRANT_AUDIT_SUMMARY_MAX_CHARS),
          verdict: `refused:${input.reason}`,
          exitCode: null,
          challengeId: null,
          approvalScope: null,
          ts: input.now,
          // Nothing will follow a refusal: the row is complete the moment it is written.
          resultAt: input.now,
        })
        .returning();
      return asRecord(row!);
    },

    async recordResult(input) {
      const [row] = await db
        .update(driveEnvGrantAudit)
        .set({ verdict: input.verdict, exitCode: input.exitCode, resultAt: input.now })
        // Only a row still WAITING takes an answer: a second result for the same grant changes nothing.
        .where(and(eq(driveEnvGrantAudit.grantId, input.grantId), isNull(driveEnvGrantAudit.resultAt)))
        .returning();
      return row ? asRecord(row) : null;
    },

    async listForEnv({ envId, limit }) {
      const rows = await db
        .select()
        .from(driveEnvGrantAudit)
        .where(eq(driveEnvGrantAudit.envId, envId))
        .orderBy(desc(driveEnvGrantAudit.ts))
        .limit(Math.min(limit, GRANT_AUDIT_LIST_LIMIT));
      return rows.map(asRecord);
    },

    async listForOwner({ ownerId, limit }) {
      const rows = await db
        .select({ audit: driveEnvGrantAudit })
        .from(driveEnvGrantAudit)
        .innerJoin(driveEnvLocal, eq(driveEnvLocal.envId, driveEnvGrantAudit.envId))
        .where(eq(driveEnvLocal.ownerId, ownerId))
        .orderBy(desc(driveEnvGrantAudit.ts))
        .limit(Math.min(limit, GRANT_AUDIT_LIST_LIMIT));
      return rows.map((row) => asRecord(row.audit));
    },
  };
}
