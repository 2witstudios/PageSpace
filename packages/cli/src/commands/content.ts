/**
 * `pagespace pages read|replace-lines` (Phase 5 task 2). Thin projections
 * over the `pages.read`/`pages.replaceLines` SDK operations (documents
 * namespace, already wired on the client by Phase 3 task 2).
 *
 * `--start`/`--end` and `--file` are not part of the global argv grammar
 * (`parseArgv` only extracts `--json`/`--yes`/`--host`/etc.), so each is
 * extracted locally from `CommandIntent.args` the same way `extractDriveFlag`
 * handles `--drive` — a small composable scanner that consumes what it
 * understands and passes the remainder through `rest`.
 *
 * Range validation (1-based, `end >= start`) happens here as a usage error
 * (exit 2) before any SDK call, even though the SDK's own zod schema would
 * eventually reject the same input — that rejection surfaces as a runtime
 * error (exit 1) via `callSdk`, which is the wrong exit code for a malformed
 * command.
 *
 * `replaceLines`' content is read byte-exact from stdin or `--file` (no
 * trim, no injected trailing newline) and passed straight through to the
 * SDK — the coding-harness hot path depends on trailing-newline fidelity
 * surviving a read -> replace -> read round trip.
 */
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { callSdk } from './sdk-error.js';

interface RangeFlagsResult {
  readonly ok: true;
  readonly startLine: number | undefined;
  readonly endLine: number | undefined;
  readonly rest: readonly string[];
}
interface RangeFlagsError {
  readonly ok: false;
  readonly message: string;
}

/** Pure: no I/O. Consumes `--start`/`--end`, passes everything else through in `rest`. */
export function extractLineRangeFlags(args: readonly string[]): RangeFlagsResult | RangeFlagsError {
  let startLine: number | undefined;
  let endLine: number | undefined;
  const rest: string[] = [];
  let i = 0;
  while (i < args.length) {
    if (args[i] === '--start' || args[i] === '--end') {
      const flag = args[i] as '--start' | '--end';
      const value = args[i + 1];
      if (value === undefined) return { ok: false, message: `Flag ${flag} requires a value.` };
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return { ok: false, message: `Invalid ${flag} "${value}": must be an integer >= 1.` };
      }
      if (flag === '--start') startLine = parsed;
      else endLine = parsed;
      i += 2;
      continue;
    }
    rest.push(args[i] as string);
    i += 1;
  }
  if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
    return { ok: false, message: `--end (${endLine}) must be >= --start (${startLine}).` };
  }
  return { ok: true, startLine, endLine, rest };
}

/** Pure: no I/O. */
function extractRawFlag(args: readonly string[]): { readonly raw: boolean; readonly rest: readonly string[] } {
  const rest: string[] = [];
  let raw = false;
  for (const arg of args) {
    if (arg === '--raw') raw = true;
    else rest.push(arg);
  }
  return { raw, rest };
}

/** Pure: no I/O. */
function extractFileFlag(
  args: readonly string[],
): { readonly ok: true; readonly filePath: string | undefined; readonly rest: readonly string[] } | { readonly ok: false; readonly message: string } {
  const rest: string[] = [];
  let filePath: string | undefined;
  let i = 0;
  while (i < args.length) {
    if (args[i] === '--file') {
      const value = args[i + 1];
      if (value === undefined) return { ok: false, message: 'Flag --file requires a value.' };
      filePath = value;
      i += 2;
      continue;
    }
    rest.push(args[i] as string);
    i += 1;
  }
  return { ok: true, filePath, rest };
}

export const pagesReadHandler: CommandHandler = async (ctx, intent) => {
  const [pageId, ...rest0] = intent.args;
  if (!pageId) {
    ctx.stderr.write('Usage: pagespace pages read <pageId> [--start N] [--end M] [--raw]\n');
    return EXIT_USAGE_ERROR;
  }

  const { raw, rest: rest1 } = extractRawFlag(rest0);
  const range = extractLineRangeFlags(rest1);
  if (!range.ok) {
    ctx.stderr.write(`${range.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  if (range.rest.length > 0) {
    ctx.stderr.write(`Unknown argument: ${range.rest[0]}\n`);
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () =>
    ctx.sdk.pages.read({ operation: 'read', pageId, startLine: range.startLine, endLine: range.endLine }),
  );
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else if ('content' in result.value) {
    ctx.stdout.write(raw ? result.value.content : `${result.value.numberedLines.join('\n')}\n`);
  } else {
    // A FILE page not yet in `completed` status has no text content to read.
    ctx.stdout.write(`${result.value.message ?? result.value.error ?? `No readable content (status: ${result.value.status}).`}\n`);
  }
  return EXIT_SUCCESS;
};

export interface ContentSourceDeps {
  readonly readStdin: () => Promise<string>;
  readonly readFile: (path: string) => Promise<string>;
}

export function createPagesReplaceLinesHandler(deps: ContentSourceDeps): CommandHandler {
  return async (ctx, intent) => {
    const [pageId, ...rest0] = intent.args;
    if (!pageId) {
      ctx.stderr.write('Usage: pagespace pages replace-lines <pageId> --start N [--end M] [--file <path>]\n');
      return EXIT_USAGE_ERROR;
    }

    const fileFlag = extractFileFlag(rest0);
    if (!fileFlag.ok) {
      ctx.stderr.write(`${fileFlag.message}\n`);
      return EXIT_USAGE_ERROR;
    }
    const range = extractLineRangeFlags(fileFlag.rest);
    if (!range.ok) {
      ctx.stderr.write(`${range.message}\n`);
      return EXIT_USAGE_ERROR;
    }
    if (range.rest.length > 0) {
      ctx.stderr.write(`Unknown argument: ${range.rest[0]}\n`);
      return EXIT_USAGE_ERROR;
    }
    if (range.startLine === undefined) {
      ctx.stderr.write('Flag --start is required.\n');
      return EXIT_USAGE_ERROR;
    }

    let content: string;
    try {
      content = fileFlag.filePath !== undefined ? await deps.readFile(fileFlag.filePath) : await deps.readStdin();
    } catch (error) {
      ctx.stderr.write(`Failed to read input: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_RUNTIME_ERROR;
    }

    const result = await callSdk(ctx.stderr, () =>
      ctx.sdk.pages.replaceLines({ operation: 'replace', pageId, startLine: range.startLine as number, endLine: range.endLine, content }),
    );
    if (!result.ok) return EXIT_RUNTIME_ERROR;

    if (intent.flags.json) {
      ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
    } else {
      ctx.stdout.write(`Replaced line(s) ${result.value.affectedLines} in ${pageId} (${result.value.totalLines} lines total)\n`);
    }
    return EXIT_SUCCESS;
  };
}

async function readStdinToString(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export const pagesReplaceLinesHandler: CommandHandler = createPagesReplaceLinesHandler({
  readStdin: readStdinToString,
  readFile: (path) => readFile(path, 'utf-8'),
});
