/**
 * `pagespace env disconnect <enrollmentId>` — stop a running `env connect`
 * for this enrollment (invariant 8: Ctrl-C / `env disconnect` always wins
 * locally). The daemon never listens (invariant 1), so there is no socket to
 * ask; it leaves a `PidRecord` in `~/.pagespace/env-connect.<enrollmentId>.pid`
 * and refreshes it every `PID_HEARTBEAT_MS` while it lives.
 *
 * Signalling a bare pid is unsafe: an ungraceful exit leaves the file behind,
 * and after the OS reuses that pid, `SIGTERM` would hit an unrelated process
 * owned by the same user (it would not raise `ESRCH`). So before signalling,
 * this validates the record: it must parse as ours (an `argv0` of `pagespace`),
 * it must be fresh (a record older than `PID_STALE_MS` means the daemon stopped
 * refreshing it — dead), and the process must answer a `signal 0` probe. A
 * record that fails any check is removed and the command refuses.
 */
import { readFileSync, statSync, unlinkSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../../exit-codes.js';
import type { CommandHandler } from '../../router/router.js';
import { PID_HEARTBEAT_MS, pidFilePath, type PidRecord } from './connect.js';

/** A record older than this (its file has not been refreshed for three heartbeats) is treated as a dead daemon. */
export const PID_STALE_MS = PID_HEARTBEAT_MS * 3;
/** The argv0 identity `env connect` writes; a file without it is not ours. */
const EXPECTED_ARGV0 = 'pagespace';

export interface ReadPidResult {
  readonly record: PidRecord;
  /** How long ago the file was last written (mtime), in ms. */
  readonly ageMs: number;
}

export interface EnvDisconnectHandlerDeps {
  readonly homedir: string;
  /** `null` when there is no pid file. */
  readonly readPidFile: (path: string) => ReadPidResult | null;
  readonly removePidFile: (path: string) => void;
  /** `signal 0` probes liveness; a real signal stops it. Throws `code: 'ESRCH'` when the process is gone, `'EPERM'` when it is someone else's. */
  readonly kill: (pid: number, signal: NodeJS.Signals | 0) => void;
}

const codeOf = (error: unknown): string | undefined => (typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined);

function isOurRecord(record: PidRecord): boolean {
  return Number.isInteger(record.pid) && record.pid > 0 && record.argv0 === EXPECTED_ARGV0 && Number.isFinite(record.startedAt);
}

export function createEnvDisconnectHandler(deps: EnvDisconnectHandlerDeps): CommandHandler {
  return async (ctx, intent) => {
    const [enrollmentId] = intent.args;
    if (!enrollmentId) {
      ctx.stderr.write('Usage: pagespace env disconnect <enrollmentId>\n');
      return EXIT_USAGE_ERROR;
    }
    const path = pidFilePath(deps.homedir, enrollmentId);
    const found = deps.readPidFile(path);
    if (found === null) {
      ctx.stderr.write(`No running "pagespace env connect ${enrollmentId}" found (no pid file at ${path}).\n`);
      return EXIT_RUNTIME_ERROR;
    }
    const { record, ageMs } = found;

    // Not our record, or gone stale (the daemon stopped refreshing it): remove
    // and refuse. Signalling here could hit a reused pid — an unrelated process.
    if (!isOurRecord(record) || ageMs > PID_STALE_MS) {
      deps.removePidFile(path);
      ctx.stderr.write(`The pid file at ${path} is stale (${!isOurRecord(record) ? 'not written by env connect' : `not refreshed for ${Math.round(ageMs / 1000)}s`}); removed it and refusing to signal pid ${record.pid} — after pid reuse it could belong to another process.\n`);
      return EXIT_RUNTIME_ERROR;
    }

    // Probe liveness without stopping anything; ESRCH ⇒ dead, clean up.
    try {
      deps.kill(record.pid, 0);
    } catch (error) {
      if (codeOf(error) === 'ESRCH') {
        deps.removePidFile(path);
        ctx.stderr.write(`Stale pid file removed: process ${record.pid} for enrollment ${enrollmentId} is no longer running.\n`);
        return EXIT_RUNTIME_ERROR;
      }
      ctx.stderr.write(`Could not signal process ${record.pid}: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_RUNTIME_ERROR;
    }

    try {
      deps.kill(record.pid, 'SIGTERM');
    } catch (error) {
      ctx.stderr.write(`Could not signal process ${record.pid}: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_RUNTIME_ERROR;
    }
    if (intent.flags.json) ctx.stdout.write(`${JSON.stringify({ enrollmentId, pid: record.pid, signal: 'SIGTERM' })}\n`);
    else ctx.stdout.write(`Sent SIGTERM to env connect (pid ${record.pid}) for enrollment ${enrollmentId}; it closes its socket and kills its children.\n`);
    return EXIT_SUCCESS;
  };
}

function readPidFile(path: string): ReadPidResult | null {
  let raw: string;
  let ageMs: number;
  try {
    raw = readFileSync(path, 'utf8');
    ageMs = Date.now() - statSync(path).mtimeMs;
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return null;
    throw error;
  }
  // A record that is not our shape — a legacy bare-integer pid file (valid JSON
  // but not an object), a truncated write (JSON.parse throws), or a missing
  // field — is reported with a sentinel the caller rejects (pid 0 fails
  // isOurRecord), so a foreign or corrupt file is removed, never signalled.
  const invalid: ReadPidResult = { record: { pid: 0, startedAt: 0, argv0: '' }, ageMs };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalid;
  }
  if (typeof parsed !== 'object' || parsed === null) return invalid;
  const { pid, startedAt, argv0 } = parsed as Partial<PidRecord>;
  if (typeof pid !== 'number' || typeof startedAt !== 'number' || typeof argv0 !== 'string') return invalid;
  return { record: { pid, startedAt, argv0 }, ageMs };
}

export const envDisconnectHandler: CommandHandler = createEnvDisconnectHandler({
  homedir: osHomedir(),
  readPidFile,
  removePidFile: (path) => {
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
  },
  kill: (pid, signal) => process.kill(pid, signal),
});
