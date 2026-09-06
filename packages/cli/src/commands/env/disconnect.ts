/**
 * `pagespace env disconnect <enrollmentId>` — stop a running `env connect`
 * for this enrollment (invariant 8: Ctrl-C / `env disconnect` always wins
 * locally). The daemon never listens (invariant 1), so there is no socket to
 * ask; it leaves its pid in `~/.pagespace/env-connect.<enrollmentId>.pid`
 * and this command sends that pid SIGTERM, which the daemon handles exactly
 * like Ctrl-C: close the socket, kill every child process group, exit 0.
 * A stale pid file (no such process) is removed and reported.
 */
import { readFileSync, unlinkSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../../exit-codes.js';
import type { CommandHandler } from '../../router/router.js';
import { pidFilePath } from './connect.js';

export interface EnvDisconnectHandlerDeps {
  readonly homedir: string;
  /** `null` when there is no pid file. */
  readonly readPid: (path: string) => number | null;
  readonly removePidFile: (path: string) => void;
  /** Throws with `code: 'ESRCH'` when the process is gone. */
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
}

const codeOf = (error: unknown): string | undefined => (typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined);

export function createEnvDisconnectHandler(deps: EnvDisconnectHandlerDeps): CommandHandler {
  return async (ctx, intent) => {
    const [enrollmentId] = intent.args;
    if (!enrollmentId) {
      ctx.stderr.write('Usage: pagespace env disconnect <enrollmentId>\n');
      return EXIT_USAGE_ERROR;
    }
    const path = pidFilePath(deps.homedir, enrollmentId);
    const pid = deps.readPid(path);
    if (pid === null) {
      ctx.stderr.write(`No running "pagespace env connect ${enrollmentId}" found (no pid file at ${path}).\n`);
      return EXIT_RUNTIME_ERROR;
    }
    try {
      deps.kill(pid, 'SIGTERM');
    } catch (error) {
      if (codeOf(error) === 'ESRCH') {
        deps.removePidFile(path);
        ctx.stderr.write(`Stale pid file removed: process ${pid} for enrollment ${enrollmentId} is no longer running.\n`);
        return EXIT_RUNTIME_ERROR;
      }
      ctx.stderr.write(`Could not signal process ${pid}: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_RUNTIME_ERROR;
    }
    if (intent.flags.json) ctx.stdout.write(`${JSON.stringify({ enrollmentId, pid, signal: 'SIGTERM' })}\n`);
    else ctx.stdout.write(`Sent SIGTERM to env connect (pid ${pid}) for enrollment ${enrollmentId}; it closes its socket and kills its children.\n`);
    return EXIT_SUCCESS;
  };
}

function readPidFile(path: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return null;
    throw error;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export const envDisconnectHandler: CommandHandler = createEnvDisconnectHandler({
  homedir: osHomedir(),
  readPid: readPidFile,
  removePidFile: (path) => {
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
  },
  kill: (pid, signal) => process.kill(pid, signal),
});
