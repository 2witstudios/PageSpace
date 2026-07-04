/**
 * `pagespace pages export` (Phase 5 task 2). Thin projection over the
 * `export.pageMarkdown`/`export.sheetCsv` SDK operations (Phase 3 task 10;
 * this task also fixed the client facade gap — see `packages/sdk/src/client.ts`).
 *
 * Both operations are `textResponse: true` — the SDK response is already
 * the raw exported text, not a JSON envelope. `--out -` writes that text
 * verbatim to stdout (nothing else on stdout in that mode), regardless of
 * `--json`: wrapping already-raw text in a JSON string would defeat the
 * point of piping it. Writing to a file refuses to silently overwrite an
 * existing path — `--force` is the only opt-out, checked before the SDK
 * call so a doomed write never costs a network round trip.
 */
import { access, writeFile as writeFileToDisk } from 'node:fs/promises';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { callSdk } from './sdk-error.js';

const FORMATS = ['md', 'csv'] as const;
type ExportFormat = (typeof FORMATS)[number];

/** Pure: no I/O. */
function extractExportFlags(
  args: readonly string[],
):
  | { readonly ok: true; readonly format: string | undefined; readonly out: string | undefined; readonly rest: readonly string[] }
  | { readonly ok: false; readonly message: string } {
  const rest: string[] = [];
  let format: string | undefined;
  let out: string | undefined;
  let i = 0;
  while (i < args.length) {
    if (args[i] === '--format' || args[i] === '--out') {
      const flag = args[i] as '--format' | '--out';
      const value = args[i + 1];
      if (value === undefined) return { ok: false, message: `Flag ${flag} requires a value.` };
      if (flag === '--format') format = value;
      else out = value;
      i += 2;
      continue;
    }
    rest.push(args[i] as string);
    i += 1;
  }
  return { ok: true, format, out, rest };
}

export interface PagesExportDeps {
  readonly fileExists: (path: string) => Promise<boolean>;
  readonly writeFile: (path: string, content: string) => Promise<void>;
}

export function createPagesExportHandler(deps: PagesExportDeps): CommandHandler {
  return async (ctx, intent) => {
    const [pageId, ...rest0] = intent.args;
    if (!pageId) {
      ctx.stderr.write('Usage: pagespace pages export <pageId> --format md|csv --out <path|-> [--force]\n');
      return EXIT_USAGE_ERROR;
    }

    const parsed = extractExportFlags(rest0);
    if (!parsed.ok) {
      ctx.stderr.write(`${parsed.message}\n`);
      return EXIT_USAGE_ERROR;
    }
    if (parsed.rest.length > 0) {
      ctx.stderr.write(`Unknown argument: ${parsed.rest[0]}\n`);
      return EXIT_USAGE_ERROR;
    }
    if (!parsed.format || !FORMATS.includes(parsed.format as ExportFormat)) {
      ctx.stderr.write(`Flag --format is required and must be one of: ${FORMATS.join(', ')}\n`);
      return EXIT_USAGE_ERROR;
    }
    if (!parsed.out) {
      ctx.stderr.write('Flag --out is required (a file path, or "-" for stdout).\n');
      return EXIT_USAGE_ERROR;
    }
    const format = parsed.format as ExportFormat;
    const out = parsed.out;

    if (out !== '-' && !intent.flags.force) {
      const exists = await deps.fileExists(out);
      if (exists) {
        ctx.stderr.write(`Refusing to overwrite existing file "${out}" without --force.\n`);
        return EXIT_RUNTIME_ERROR;
      }
    }

    const result = await callSdk(ctx.stderr, () =>
      format === 'md' ? ctx.sdk.export.pageMarkdown({ pageId }) : ctx.sdk.export.sheetCsv({ pageId }),
    );
    if (!result.ok) return EXIT_RUNTIME_ERROR;

    if (out === '-') {
      ctx.stdout.write(result.value);
      return EXIT_SUCCESS;
    }

    try {
      await deps.writeFile(out, result.value);
    } catch (error) {
      ctx.stderr.write(`Failed to write "${out}": ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_RUNTIME_ERROR;
    }

    if (intent.flags.json) {
      ctx.stdout.write(`${JSON.stringify({ pageId, format, path: out, bytes: Buffer.byteLength(result.value) })}\n`);
    } else {
      ctx.stdout.write(`Exported ${pageId} as ${format} to ${out}\n`);
    }
    return EXIT_SUCCESS;
  };
}

async function fileExistsOnDisk(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export const pagesExportHandler: CommandHandler = createPagesExportHandler({
  fileExists: fileExistsOnDisk,
  writeFile: (path, content) => writeFileToDisk(path, content, 'utf-8'),
});
