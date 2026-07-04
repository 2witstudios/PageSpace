/**
 * `pagespace search text|regex|glob` (Phase 5 task 4). Thin projections over
 * the `search.*` SDK operations (Phase 3 task 3; wired onto the client facade
 * by this same task — see `@pagespace/sdk`'s `client.ts`).
 *
 * There is no per-drive "text" search route on the server — only
 * `search.glob`/`search.regex` are drive-scoped; free-text search only
 * exists as `search.multiDrive` (`searchType: 'text'`), which always
 * enumerates every drive the caller can access and has no `driveId` input.
 * `search text --drive <id>` therefore makes the same one multi-drive call
 * as `--all-drives`/the no-flag default and narrows which drive's result
 * *group* human-mode rendering shows — a pure post-call filter, not a second
 * SDK call or a fabricated request field the server would silently ignore.
 * `--json` always emits the untouched multi-drive response regardless of
 * `--drive`, matching every other verb's rule that `--json` is never a
 * filtered subset of what human mode chooses to render.
 *
 * Patterns/queries are taken from `intent.args` verbatim and forwarded
 * unchanged — the server owns pattern safety (ReDoS guards, statement
 * timeouts); this module neither sanitizes nor mangles them.
 */
import type { PageSpaceClient } from '@pagespace/sdk';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { extractDriveFlag } from './drive-flag.js';
import { callSdk } from './sdk-error.js';

type MultiDriveSearchResult = Awaited<ReturnType<PageSpaceClient['search']['multiDrive']>>;
type RegexSearchResult = Awaited<ReturnType<PageSpaceClient['search']['regex']>>;
type GlobSearchResult = Awaited<ReturnType<PageSpaceClient['search']['glob']>>;

type FlagScanResult =
  | { readonly ok: true; readonly booleans: ReadonlySet<string>; readonly values: ReadonlyMap<string, string>; readonly rest: readonly string[] }
  | { readonly ok: false; readonly message: string };

/** Pure: no I/O. Consumes any of `spec`'s flags (boolean or value-taking), passing everything else through in `rest` verbatim — patterns/queries are never touched. */
function scanFlags(args: readonly string[], spec: { readonly booleanFlags: readonly string[]; readonly valueFlags: readonly string[] }): FlagScanResult {
  const booleans = new Set<string>();
  const values = new Map<string, string>();
  const rest: string[] = [];
  let i = 0;
  while (i < args.length) {
    const token = args[i] as string;
    if (spec.booleanFlags.includes(token)) {
      booleans.add(token);
      i += 1;
      continue;
    }
    if (spec.valueFlags.includes(token)) {
      const value = args[i + 1];
      if (value === undefined) return { ok: false, message: `Flag ${token} requires a value.` };
      values.set(token, value);
      i += 2;
      continue;
    }
    rest.push(token);
    i += 1;
  }
  return { ok: true, booleans, values, rest };
}

/** Pure: no I/O. Parses a `--max-results`-style flag value against the operation's own clamp, or reports a usage error. */
function parseBoundedMaxResults(raw: string | undefined, flagName: string, min: number, max: number): { readonly ok: true; readonly value: number | undefined } | { readonly ok: false; readonly message: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return { ok: false, message: `Invalid ${flagName} "${raw}": must be an integer between ${min} and ${max}.` };
  }
  return { ok: true, value: parsed };
}

const SEARCH_IN_VALUES = ['content', 'title', 'both'] as const;
type SearchIn = (typeof SEARCH_IN_VALUES)[number];

/** Pure: no I/O. */
export function renderMultiDriveSearch(value: MultiDriveSearchResult, driveId: string | undefined): string {
  const groups = driveId === undefined ? value.results : value.results.filter((group) => group.driveId === driveId);
  const lines = groups.flatMap((group) => group.matches.map((match) => `${group.driveSlug}:${match.pageId}: ${match.excerpt}`));
  if (lines.length === 0) return 'No results.\n';
  return `${lines.join('\n')}\n`;
}

/** Pure: no I/O. */
export function renderRegexSearch(value: RegexSearchResult): string {
  const lines = value.results.flatMap((result) =>
    result.matchingLines.map((line) => `${result.semanticPath}:${result.pageId}:${line.lineNumber}: ${line.content}`),
  );
  if (lines.length === 0) return 'No results.\n';
  return `${lines.join('\n')}\n`;
}

/** Pure: no I/O. */
export function renderGlobSearch(value: GlobSearchResult): string {
  if (value.results.length === 0) return 'No results.\n';
  return `${value.results.map((result) => `${result.semanticPath}:${result.pageId}: ${result.title}`).join('\n')}\n`;
}

export const searchTextHandler: CommandHandler = async (ctx, intent) => {
  const usage = 'Usage: pagespace search text <query> [--drive <driveId>|--all-drives] [--max-results <n>]\n';

  const driveExtracted = extractDriveFlag(intent.args);
  if (!driveExtracted.ok) {
    ctx.stderr.write(`${driveExtracted.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  const parsed = scanFlags(driveExtracted.rest, { booleanFlags: ['--all-drives'], valueFlags: ['--max-results'] });
  if (!parsed.ok) {
    ctx.stderr.write(`${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  const [query, ...extra] = parsed.rest;
  if (!query || extra.length > 0) {
    ctx.stderr.write(usage);
    return EXIT_USAGE_ERROR;
  }

  const driveId = driveExtracted.driveId;
  if (driveId !== undefined && parsed.booleans.has('--all-drives')) {
    ctx.stderr.write('Flags --drive and --all-drives are mutually exclusive.\n');
    return EXIT_USAGE_ERROR;
  }

  const maxResults = parseBoundedMaxResults(parsed.values.get('--max-results'), '--max-results', 1, 50);
  if (!maxResults.ok) {
    ctx.stderr.write(`${maxResults.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () =>
    ctx.sdk.search.multiDrive({ searchQuery: query, searchType: 'text', maxResultsPerDrive: maxResults.value }),
  );
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
    return EXIT_SUCCESS;
  }

  ctx.stdout.write(renderMultiDriveSearch(result.value, driveId));
  return EXIT_SUCCESS;
};

export const searchRegexHandler: CommandHandler = async (ctx, intent) => {
  const usage = 'Usage: pagespace search regex <pattern> --drive <driveId> [--in content|title|both] [--max-results <n>]\n';

  const driveExtracted = extractDriveFlag(intent.args);
  if (!driveExtracted.ok) {
    ctx.stderr.write(`${driveExtracted.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  const parsed = scanFlags(driveExtracted.rest, { booleanFlags: [], valueFlags: ['--in', '--max-results'] });
  if (!parsed.ok) {
    ctx.stderr.write(`${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  const [pattern, ...extra] = parsed.rest;
  const driveId = driveExtracted.driveId;
  if (!pattern || !driveId || extra.length > 0) {
    ctx.stderr.write(usage);
    return EXIT_USAGE_ERROR;
  }

  const rawSearchIn = parsed.values.get('--in');
  if (rawSearchIn !== undefined && !SEARCH_IN_VALUES.includes(rawSearchIn as SearchIn)) {
    ctx.stderr.write(`Invalid --in "${rawSearchIn}". Expected one of: ${SEARCH_IN_VALUES.join(', ')}\n`);
    return EXIT_USAGE_ERROR;
  }

  const maxResults = parseBoundedMaxResults(parsed.values.get('--max-results'), '--max-results', 1, 100);
  if (!maxResults.ok) {
    ctx.stderr.write(`${maxResults.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () =>
    ctx.sdk.search.regex({ driveId, pattern, searchIn: rawSearchIn as SearchIn | undefined, maxResults: maxResults.value }),
  );
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
    return EXIT_SUCCESS;
  }

  ctx.stdout.write(renderRegexSearch(result.value));
  return EXIT_SUCCESS;
};

export const searchGlobHandler: CommandHandler = async (ctx, intent) => {
  const usage = 'Usage: pagespace search glob <pattern> --drive <driveId> [--max-results <n>]\n';

  const driveExtracted = extractDriveFlag(intent.args);
  if (!driveExtracted.ok) {
    ctx.stderr.write(`${driveExtracted.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  const parsed = scanFlags(driveExtracted.rest, { booleanFlags: [], valueFlags: ['--max-results'] });
  if (!parsed.ok) {
    ctx.stderr.write(`${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  const [pattern, ...extra] = parsed.rest;
  const driveId = driveExtracted.driveId;
  if (!pattern || !driveId || extra.length > 0) {
    ctx.stderr.write(usage);
    return EXIT_USAGE_ERROR;
  }

  const maxResults = parseBoundedMaxResults(parsed.values.get('--max-results'), '--max-results', 1, 200);
  if (!maxResults.ok) {
    ctx.stderr.write(`${maxResults.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () => ctx.sdk.search.glob({ driveId, pattern, maxResults: maxResults.value }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
    return EXIT_SUCCESS;
  }

  ctx.stdout.write(renderGlobSearch(result.value));
  return EXIT_SUCCESS;
};
