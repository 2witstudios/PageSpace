/**
 * `pagespace sheets edit-cells` (Phase 5 task 2). Thin projection over the
 * `pages.editCells` SDK operation (documents namespace, Phase 3 task 2) —
 * grouped under a `sheets` CLI resource per this task's spec even though the
 * SDK models it as a `pages.*` method, since a SHEET page's content-editing
 * surface is the natural CLI-facing grouping for this verb.
 *
 * Cell addresses/values are JSON, given via `--json-input` or stdin.
 * Malformed JSON or a non-array shape is a usage error (exit 2) before any
 * network call; the per-cell address/value shape is left to the SDK's own
 * zod validation (surfaced as a runtime error via `callSdk`), matching how
 * every other thin verb defers business-shape checks to the server/SDK.
 */
import process from 'node:process';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { callSdk } from './sdk-error.js';

/** Pure: no I/O. */
function extractJsonInputFlag(
  args: readonly string[],
): { readonly ok: true; readonly jsonInput: string | undefined; readonly rest: readonly string[] } | { readonly ok: false; readonly message: string } {
  const rest: string[] = [];
  let jsonInput: string | undefined;
  let i = 0;
  while (i < args.length) {
    if (args[i] === '--json-input') {
      const value = args[i + 1];
      if (value === undefined) return { ok: false, message: 'Flag --json-input requires a value.' };
      jsonInput = value;
      i += 2;
      continue;
    }
    rest.push(args[i] as string);
    i += 1;
  }
  return { ok: true, jsonInput, rest };
}

export interface SheetsEditCellsDeps {
  readonly readStdin: () => Promise<string>;
}

export function createSheetsEditCellsHandler(deps: SheetsEditCellsDeps): CommandHandler {
  return async (ctx, intent) => {
    const [pageId, ...rest0] = intent.args;
    if (!pageId) {
      ctx.stderr.write('Usage: pagespace sheets edit-cells <pageId> [--json-input <json>]\n');
      return EXIT_USAGE_ERROR;
    }

    const inputFlag = extractJsonInputFlag(rest0);
    if (!inputFlag.ok) {
      ctx.stderr.write(`${inputFlag.message}\n`);
      return EXIT_USAGE_ERROR;
    }
    if (inputFlag.rest.length > 0) {
      ctx.stderr.write(`Unknown argument: ${inputFlag.rest[0]}\n`);
      return EXIT_USAGE_ERROR;
    }

    let raw: string;
    try {
      raw = inputFlag.jsonInput !== undefined ? inputFlag.jsonInput : await deps.readStdin();
    } catch (error) {
      ctx.stderr.write(`Failed to read input: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_RUNTIME_ERROR;
    }

    let cells: unknown;
    try {
      cells = JSON.parse(raw);
    } catch {
      ctx.stderr.write('Invalid JSON in --json-input/stdin.\n');
      return EXIT_USAGE_ERROR;
    }
    if (!Array.isArray(cells)) {
      ctx.stderr.write('Input must be a JSON array of {address, value} cells.\n');
      return EXIT_USAGE_ERROR;
    }

    const result = await callSdk(ctx.stderr, () =>
      ctx.sdk.pages.editCells({ operation: 'edit-cells', pageId, cells: cells as Array<{ address: string; value: string }> }),
    );
    if (!result.ok) return EXIT_RUNTIME_ERROR;

    if (intent.flags.json) {
      ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
    } else {
      ctx.stdout.write(`Updated ${result.value.cellsUpdated} cell(s) in ${pageId}.\n`);
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

export const sheetsEditCellsHandler: CommandHandler = createSheetsEditCellsHandler({ readStdin: readStdinToString });
