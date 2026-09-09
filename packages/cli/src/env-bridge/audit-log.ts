/**
 * The daemon's local audit trail (invariant 10): one JSON line per decision,
 * appended to `~/.pagespace/env-audit.jsonl`, keyed by `grantId` so that the
 * server-side record joins to it. That record exists: since GA wave 3 the
 * server writes one `drive_env_grant_audit` row per grant it signs (at sign
 * time, updated when this machine's signed result lands) and one per grant it
 * refuses to sign, keyed by the same `grantId` this file carries — so a line
 * here and a row there describe the same request from both ends, and a
 * real-Postgres test in `@pagespace/lib` joins the two on that id. The owner
 * sees the server's half as the environment's activity panel; this file is
 * the machine's half, under the owner's own account. Append-only by
 * construction: the sink only ever appends, nothing here reads or rewrites.
 *
 * Audit I/O must never take the daemon down — a full disk is not a reason to
 * stop enforcing policy — so a failing sink is reported once and swallowed.
 */
import type { GrantPrincipal } from './lib-core.js';

export const AUDIT_PATH_ENV_VAR = 'PAGESPACE_ENV_AUDIT_LOG';
export const AUDIT_FILE_NAME = 'env-audit.jsonl';

export interface AuditEntry {
  /** `null` for a frame dropped before a grant could be read. */
  readonly grantId: string | null;
  readonly principal: GrantPrincipal | null;
  readonly op: string | null;
  /** `allow`, `deny:<reason>`, `dropped:<reason>`, `ask:declined`, `revoked`, … */
  readonly verdict: string;
  readonly argsHash: string | null;
  /** Exit code of the child for an executed `exec`; `null` otherwise. */
  readonly exitCode: number | null;
}

export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
}

export interface AuditLogDeps {
  readonly appendLine: (line: string) => Promise<void>;
  readonly now: () => number;
  readonly onError?: (message: string) => void;
}

export function formatAuditLine(entry: AuditEntry, ts: number): string {
  return `${JSON.stringify({
    ts: new Date(ts).toISOString(),
    grantId: entry.grantId,
    principal: entry.principal,
    op: entry.op,
    verdict: entry.verdict,
    argsHash: entry.argsHash,
    exitCode: entry.exitCode,
  })}\n`;
}

export function createAuditLog(deps: AuditLogDeps): AuditLog {
  let reported = false;
  return {
    async record(entry) {
      try {
        await deps.appendLine(formatAuditLine(entry, deps.now()));
      } catch (error) {
        if (reported) return;
        reported = true;
        deps.onError?.(`audit log write failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

export function defaultAuditPath(env: Readonly<Record<string, string | undefined>>, homedir: string): string {
  const fromEnv = env[AUDIT_PATH_ENV_VAR]?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : `${homedir}/.pagespace/${AUDIT_FILE_NAME}`;
}
