/**
 * `pagespace workspaces list|exec` — shell access to agent workspace sandboxes.
 * Thin projections over the `workspaces.*` SDK operations.
 *
 * `exec` is the one command whose exit code is not the fixed 0/1/2 contract:
 * a command that RAN exits with its own status (`remoteExitCode`), so
 * `pagespace workspaces exec <id> -- test -f x && …` composes like a local
 * shell. A refusal (not found, quota, plan) is a runtime error (1) with the
 * server's message on stderr, same as every other verb.
 */
import type { PageSpaceClient } from '@pagespace/sdk';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, remoteExitCode } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { callSdk } from './sdk-error.js';

type WorkspacesListResult = Awaited<ReturnType<PageSpaceClient['workspaces']['list']>>;

/** Pure: no I/O. */
export function renderWorkspacesList(value: WorkspacesListResult): string {
  if (value.sessions.length === 0) return 'No workspaces.\n';
  const lines = value.sessions.map(
    (workspace) =>
      `${workspace.workspaceId}  ${workspace.name}  [${workspace.sandboxStatus}]  drive: ${workspace.driveId ?? '(none)'}${
        workspace.endedAt ? '  (ended)' : ''
      }`,
  );
  return `${lines.join('\n')}\n`;
}

export const workspacesListHandler: CommandHandler = async (ctx, intent) => {
  const usage = 'Usage: pagespace workspaces list [--drive <driveId>]\n';
  let driveId: string | undefined;
  const args = intent.args;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--drive' && args[i + 1] !== undefined && !args[i + 1].startsWith('-')) {
      driveId = args[i + 1];
      i += 1;
    } else {
      ctx.stderr.write(usage);
      return EXIT_USAGE_ERROR;
    }
  }

  const result = await callSdk(ctx.stderr, () => ctx.sdk.workspaces.list(driveId ? { driveId } : {}));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  ctx.stdout.write(intent.flags.json ? `${JSON.stringify(result.value)}\n` : renderWorkspacesList(result.value));
  return EXIT_SUCCESS;
};

export type ExtractExecArgsResult =
  | { readonly ok: true; readonly workspaceId: string; readonly command: string; readonly cwd?: string; readonly timeoutMs?: number }
  | { readonly ok: false; readonly message: string };

const EXEC_USAGE = 'Usage: pagespace workspaces exec <workspaceId> [--cwd <dir>] [--timeout-ms <ms>] -- <command…>';

const SAFE_SHELL_WORD = /^[A-Za-z0-9_\-./=:@%+,]+$/;

/**
 * Pure: rebuild a command line from argv words so the remote POSIX shell sees
 * the same word boundaries the local shell delivered. Safe words stay bare;
 * anything else is single-quoted, with an embedded `'` written as `'\''`.
 */
export function quoteShellArgs(words: readonly string[]): string {
  return words
    .map((word) => (SAFE_SHELL_WORD.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`))
    .join(' ');
}

/**
 * Pure: `<workspaceId> [--cwd d] [--timeout-ms n] -- <command…>`. Exactly one
 * command argument (after `--` or without it) is sent verbatim as a shell
 * command line, so `-- 'ls | wc -l'` runs a pipeline remotely. Several
 * arguments after `--` are separate words: each is shell-quoted as needed so
 * `-- sh -c 'echo hi; exit 3'` keeps its script as one word.
 */
export function extractExecArgs(args: readonly string[]): ExtractExecArgsResult {
  const separator = args.indexOf('--');
  const head = separator === -1 ? args : args.slice(0, separator);
  const tail = separator === -1 ? [] : args.slice(separator + 1);

  let workspaceId: string | undefined;
  let cwd: string | undefined;
  let timeoutMs: number | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < head.length; i += 1) {
    const token = head[i];
    if (token === '--cwd' || token === '--timeout-ms') {
      const value = head[i + 1];
      if (value === undefined || value.length === 0) return { ok: false, message: `Flag ${token} requires a value.` };
      i += 1;
      if (token === '--cwd') {
        cwd = value;
      } else {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return { ok: false, message: 'Flag --timeout-ms requires a positive whole number of milliseconds.' };
        }
        timeoutMs = parsed;
      }
    } else if (token.startsWith('--')) {
      return { ok: false, message: `Unknown flag: ${token}` };
    } else if (workspaceId === undefined) {
      workspaceId = token;
    } else {
      positionals.push(token);
    }
  }

  if (workspaceId === undefined) return { ok: false, message: EXEC_USAGE };
  if (separator !== -1 && positionals.length > 0) {
    return { ok: false, message: `Unexpected argument before --: ${positionals[0]}` };
  }
  const commandParts = separator === -1 ? positionals : tail;
  if (separator === -1 && commandParts.length > 1) {
    return { ok: false, message: `Put the command after --, or quote it as one argument.\n${EXEC_USAGE}` };
  }
  const command = commandParts.length === 1 ? commandParts[0] : quoteShellArgs(commandParts);
  if (command.trim().length === 0) return { ok: false, message: EXEC_USAGE };

  return {
    ok: true,
    workspaceId,
    command,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

export const workspacesExecHandler: CommandHandler = async (ctx, intent) => {
  const parsed = extractExecArgs(intent.args);
  if (!parsed.ok) {
    ctx.stderr.write(`${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  const result = await callSdk(ctx.stderr, () =>
    ctx.sdk.workspaces.exec({
      workspaceId: parsed.workspaceId,
      command: parsed.command,
      cwd: parsed.cwd,
      timeoutMs: parsed.timeoutMs,
    }),
  );
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  const { stdout, stderr, exitCode, truncated } = result.value;
  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    if (stdout.length > 0) ctx.stdout.write(stdout);
    if (stderr.length > 0) ctx.stderr.write(stderr);
    if (truncated) ctx.stderr.write('[pagespace] output was truncated by the sandbox\n');
  }
  return remoteExitCode(exitCode);
};
