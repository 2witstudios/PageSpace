/**
 * Spec ID-coverage gate (Organizations & Wallets, requirement X-6 / Sequence Spec lane A4).
 *
 * The Spec (PageSpace page drc7x34unhc0ty1dc0u1j3gy) numbers every requirement:
 * ORG-n, DRV-n, SEAT-n, WAL-n, MON-n, SPEND-n, POL-n, SEC-n, AUD-n, UI-n, X-n. The epic's
 * contract is that every test description carries the ID it guards ("MON-2 …"). This script
 * makes that contract a build gate:
 *
 *   1. Load the Spec — from the page via the `pagespace` CLI when a credential is present,
 *      otherwise from the committed snapshot `docs/specs/organizations-wallets.md` (CI has no
 *      credential, so CI always reads the snapshot; the orchestrator refreshes it).
 *   2. Extract every requirement ID.
 *   3. Scan every `*.test.ts(x)` / `*.spec.ts(x)` under `packages/` and `apps/` and collect the
 *      test NAMES: the string literal passed to `it` / `test` / `describe` (and playwright's
 *      `test.describe` / `test.step`), plus the `given:` / `should:` strings that are themselves
 *      arguments to the repo's riteway-style `assert({ given, should, … })` helper. None of this
 *      counts unless it EXECUTES: a declaration under `.skip` / `.todo` / `.fixme`, one nested
 *      inside a `describe.skip(...)` / `describe.skipIf(...)(...)` block (however the inner call
 *      is itself spelled), a `RegExp.test('MON-2 …')` method call, or a plain object that merely
 *      has `given`/`should` keys without being passed to `assert(...)` — none of these run a
 *      test, so none of them count.
 *   4. Print a table ID → files, and exit non-zero listing every ID that no test names.
 *
 * The allowlist (`scripts/spec-coverage-allowlist.txt`) holds IDs not yet in scope. EVERY ID
 * starts allowlisted; a lane removes its IDs from the file in the same PR that lands the tests.
 * The gate is a ratchet in both directions: an allowlisted ID that a test now names FAILS with
 * "remove it from the allowlist", so the file can only shrink as work lands, and an allowlisted
 * token that is not a Spec ID FAILS as a typo.
 *
 * Usage:  bun run scripts/check-spec-coverage.ts [--ids MON-2,X-6] [--allowlist <path>]
 *                [--snapshot <path>] [--offline] [--json]
 *   --ids       check only these IDs (comma-separated); the allowlist still applies
 *   --offline   never call the pagespace CLI; read the snapshot only (what CI does)
 *   --json      machine-readable report on stdout instead of the table
 * Exit:   0 = every in-scope ID is named by at least one live test; 1 = at least one gap
 *         (or a stale / unknown allowlist entry, or the Spec could not be loaded).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SPEC_PAGE_ID = 'drc7x34unhc0ty1dc0u1j3gy';
export const DEFAULT_SNAPSHOT = 'docs/specs/organizations-wallets.md';
export const DEFAULT_ALLOWLIST = 'scripts/spec-coverage-allowlist.txt';
export const DEFAULT_SCAN_ROOTS = ['packages', 'apps'];

/** One requirement ID as it appears in the Spec, e.g. "MON-2". */
export const REQUIREMENT_ID_PATTERN = /\b(ORG|DRV|SEAT|WAL|MON|SPEND|POL|SEC|AUD|UI|X)-\d+\b/g;

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', 'coverage', '.turbo', '.git', 'build', 'out']);
// `.spec.ts(x)` too: apps/e2e's Playwright suite (the one that will carry most WAL/ORG/SEC UI
// requirements) uses that extension exclusively, and several vitest configs in this repo accept
// it as well. `.test.` remains the primary convention; `.spec.` is not a second, competing one.
const TEST_FILE = /\.(test|spec)\.tsx?$/;

export interface CoverageRow {
  id: string;
  /** Repo-relative test files whose names carry the ID. */
  files: string[];
  allowlisted: boolean;
}

export interface CoverageReport {
  rows: CoverageRow[];
  /** IDs with no test and not allowlisted — the gate failures. */
  missing: string[];
  /** IDs with no test that the allowlist excuses. */
  allowlistedMissing: string[];
  /** Allowlisted IDs that a test now names — must be removed from the allowlist. */
  staleAllowlist: string[];
  /** Allowlist tokens that are not IDs in the Spec. */
  unknownAllowlist: string[];
  /** Number of test files scanned. */
  scannedFiles: number;
}

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

/** Sorted, unique requirement IDs found anywhere in the Spec text. Numeric-aware order. */
export function extractRequirementIds(specText: string): string[] {
  const ids = new Set<string>();
  for (const m of specText.matchAll(REQUIREMENT_ID_PATTERN)) ids.add(m[0]);
  return [...ids].sort(compareIds);
}

export function compareIds(a: string, b: string): number {
  const [pa, na] = splitId(a);
  const [pb, nb] = splitId(b);
  return pa === pb ? na - nb : pa.localeCompare(pb);
}

function splitId(id: string): [string, number] {
  const dash = id.lastIndexOf('-');
  return [id.slice(0, dash), Number(id.slice(dash + 1))];
}

/** The `pagespace pages read` output prefixes each line with "  12 | "; strip it. */
export function stripLineNumberPrefixes(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*\d+ \| ?/, ''))
    .join('\n');
}

/**
 * Remove comments so a commented-out `// it('MON-2 …')` cannot count as coverage.
 * Block comments are removed wholesale; line comments only when the whole line is one, so a
 * test name containing `//` (a URL) is left intact.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// `(?<![.\w])` (not `\b`) in front of the declaration name is load-bearing: `\b` only blocks a
// preceding WORD character, so `someRegex.test('MON-2 ...')` — a RegExp method call, not a test
// declaration — still starts with a word boundary (`.` to `t`) and would otherwise match. The
// lookbehind blocks both a preceding identifier character AND a preceding `.` (member access).
const DECLARATION =
  /(?<![.\w])((?:it|test|describe)(?:\.(?:only|concurrent|sequential|serial|describe|step))*(?:\.(?:skipIf|runIf)\([^)]*\))?)\s*\(\s*(['"`])((?:\\.|(?!\2)[\s\S])*?)\2/g;
/** A `describe`/`test.describe` head using `.skipIf`/`.runIf` — the suite's OWN name may never run. */
const DESCRIBE_CONDITIONAL_SKIP = /^(?:test\.describe|describe)(?:\.[a-zA-Z]+)*\.(?:skipIf|runIf)\(/;
const RITEWAY_FIELD = /\b(?:given|should)\s*:\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
const SKIP_BLOCK_TRIGGER = /(?<![.\w])(?:test\.describe|describe)\.(?:skip|skipIf)\b/g;
const ASSERT_CALL = /(?<![.\w])assert\s*\(/g;

/** Index of the character matching the opening quote/backtick at `start` (which must be one). */
function skipStringLiteral(source: string, start: number): number {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i;
    i++;
  }
  return source.length - 1;
}

/** First unquoted occurrence of `target` at or after `from`, skipping over string/template literals. */
function findNextUnquoted(source: string, from: number, target: string): number {
  let i = from;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipStringLiteral(source, i) + 1;
      continue;
    }
    if (ch === target) return i;
    i++;
  }
  return -1;
}

/**
 * Index of the bracket matching the one at `openIndex` (`source[openIndex]` must be `openChar`),
 * skipping over string/template literals so a brace or paren inside a description string is
 * never mistaken for a real one.
 */
function findMatchingBracket(source: string, openIndex: number, openChar: string, closeChar: string): number {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipStringLiteral(source, i);
      continue;
    }
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** True when `index` falls strictly inside one of `regions` (each an inclusive `[start, end]`). */
function isWithinRegion(index: number, regions: readonly (readonly [number, number])[]): boolean {
  return regions.some(([start, end]) => index > start && index < end);
}

/** The `(...)` immediately at or after `from`, or `null` if there is no unquoted `(` there. */
function findCallParens(source: string, from: number): [number, number] | null {
  const open = findNextUnquoted(source, from, '(');
  if (open === -1) return null;
  const close = findMatchingBracket(source, open, '(', ')');
  return close === -1 ? null : [open, close];
}

/**
 * Byte ranges of every `describe.skip(...)` / `describe.skipIf(...)(...)` (and Playwright's
 * `test.describe.skip`/`test.describe.skipIf`) block body. A nested `it`/`test` inside one of
 * these does not run when the wrapping suite is skipped, however the inner call itself is
 * spelled — so it must not count as live coverage on its own.
 *
 * The `{` search is bounded to the triggering call's OWN argument list (the condition call's
 * parens for `.skipIf`/`.runIf`, then the real call after it). Searching unbounded from the
 * trigger forward — as an earlier version of this function did — means `describe.skip('name',
 * namedCallbackRef)` (a named reference, no inline block) has no `{` in its own call, so the
 * search would run on into whatever comes textually next in the file and could swallow a later,
 * completely unrelated `it()`'s own callback body as a "skip region".
 */
function findSkipRegions(source: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  for (const m of source.matchAll(SKIP_BLOCK_TRIGGER)) {
    const isConditional = /(?:skipIf|runIf)$/.test(m[0]);
    const firstCall = findCallParens(source, m.index + m[0].length);
    if (!firstCall) continue;
    // `.skipIf(cond)(...)`/`.runIf(cond)(...)` are curried: `firstCall` is the condition's own
    // parens, and the real call — the one that can carry an inline block — is the next one.
    const callSpan = isConditional ? findCallParens(source, firstCall[1] + 1) : firstCall;
    if (!callSpan) continue;
    const [callOpen, callClose] = callSpan;
    const braceIndex = findNextUnquoted(source, callOpen, '{');
    if (braceIndex === -1 || braceIndex > callClose) continue;
    const closeIndex = findMatchingBracket(source, braceIndex, '{', '}');
    if (closeIndex === -1) continue;
    regions.push([braceIndex, closeIndex]);
  }
  return regions;
}

/** Byte ranges of every `assert(...)` call's argument list (the repo's riteway-style helper). */
function findAssertRegions(source: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  for (const m of source.matchAll(ASSERT_CALL)) {
    const openParen = m.index + m[0].length - 1;
    const closeParen = findMatchingBracket(source, openParen, '(', ')');
    if (closeParen === -1) continue;
    regions.push([openParen, closeParen]);
  }
  return regions;
}

/**
 * Test names declared LIVE in a source file: `it`/`test`/`describe` string arguments (no
 * `.skip`/`.todo`/`.fixme` in the chain, and not nested inside a `describe.skip`/`describe.skipIf`
 * block) plus riteway `given:`/`should:` strings that are themselves arguments to an `assert(...)`
 * call (not any object literal that merely happens to have those keys).
 */
export function extractTestNames(source: string): string[] {
  const clean = stripComments(source);
  const skipRegions = findSkipRegions(clean);
  const assertRegions = findAssertRegions(clean);
  const names: string[] = [];
  for (const m of clean.matchAll(DECLARATION)) {
    if (isWithinRegion(m.index, skipRegions)) continue;
    // `describe.skipIf(cond)('name', …)` is curried like `it.skipIf`, so the modifier group
    // above matches it — but unlike `it.skipIf`, a describe-level conditional skip means the
    // SUITE's own declared name (not just its children) may never execute.
    if (DESCRIBE_CONDITIONAL_SKIP.test(m[1])) continue;
    names.push(m[3]);
  }
  for (const m of clean.matchAll(RITEWAY_FIELD)) {
    if (!isWithinRegion(m.index, assertRegions)) continue;
    if (isWithinRegion(m.index, skipRegions)) continue;
    names.push(m[2]);
  }
  return names;
}

/** True when `name` carries `id` as a whole token ("MON-2" does not match "MON-20"). */
export function nameCarriesId(name: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Z0-9-])${escaped}(?![0-9])`).test(name);
}

export function idsNamedBy(names: string[], ids: readonly string[]): Set<string> {
  const hit = new Set<string>();
  for (const id of ids) {
    if (names.some((n) => nameCarriesId(n, id))) hit.add(id);
  }
  return hit;
}

/** Parse the allowlist: one ID per line, `#` comments and blank lines ignored. */
export function parseAllowlist(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line) out.push(line);
  }
  return out;
}

export interface BuildReportInput {
  ids: readonly string[];
  /** Repo-relative test file → the IDs its live test names carry. */
  hitsByFile: ReadonlyMap<string, ReadonlySet<string>>;
  allowlist: readonly string[];
  /** Optional `--ids` filter; when set only these IDs are reported. */
  onlyIds?: readonly string[];
}

export function buildReport({ ids, hitsByFile, allowlist, onlyIds }: BuildReportInput): CoverageReport {
  const specIds = new Set(ids);
  const allow = new Set(allowlist);
  const unknownAllowlist = allowlist.filter((id) => !specIds.has(id)).sort(compareIds);
  const scope = onlyIds && onlyIds.length > 0 ? ids.filter((id) => onlyIds.includes(id)) : [...ids];

  const rows: CoverageRow[] = scope.map((id) => {
    const files: string[] = [];
    for (const [file, hits] of hitsByFile) if (hits.has(id)) files.push(file);
    files.sort();
    return { id, files, allowlisted: allow.has(id) };
  });

  return {
    rows,
    missing: rows.filter((r) => r.files.length === 0 && !r.allowlisted).map((r) => r.id),
    allowlistedMissing: rows.filter((r) => r.files.length === 0 && r.allowlisted).map((r) => r.id),
    staleAllowlist: rows.filter((r) => r.files.length > 0 && r.allowlisted).map((r) => r.id),
    unknownAllowlist,
    scannedFiles: hitsByFile.size,
  };
}

export function reportPasses(report: CoverageReport): boolean {
  return (
    report.missing.length === 0 &&
    report.staleAllowlist.length === 0 &&
    report.unknownAllowlist.length === 0
  );
}

export function formatTable(report: CoverageReport): string {
  const width = Math.max(4, ...report.rows.map((r) => r.id.length));
  const lines = [`${'ID'.padEnd(width)}  STATUS       FILES`];
  for (const r of report.rows) {
    const status = r.files.length > 0 ? (r.allowlisted ? 'STALE-ALLOW' : 'covered') : r.allowlisted ? 'allowlisted' : 'MISSING';
    lines.push(`${r.id.padEnd(width)}  ${status.padEnd(11)}  ${r.files.length > 0 ? r.files.join(', ') : '-'}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// IO edges
// ---------------------------------------------------------------------------

export function findTestFiles(root: string, roots: readonly string[] = DEFAULT_SCAN_ROOTS): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
        found.push(path.relative(root, path.join(dir, entry.name)));
      }
    }
  };
  for (const r of roots) walk(path.join(root, r));
  return found.sort();
}

export function scanTestFiles(root: string, files: readonly string[], ids: readonly string[]): Map<string, Set<string>> {
  const hits = new Map<string, Set<string>>();
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    hits.set(file, idsNamedBy(extractTestNames(source), ids));
  }
  return hits;
}

export interface SpecSource {
  text: string;
  origin: 'page' | 'snapshot';
}

/**
 * Read the Spec from the page when the CLI is installed and has a credential; otherwise the
 * snapshot. A page read that returns no requirement IDs is treated as a failure (an auth error
 * message must not masquerade as an empty Spec).
 */
export function loadSpec(root: string, opts: { snapshot: string; offline: boolean }): SpecSource {
  if (!opts.offline) {
    const result = spawnSync('pagespace', ['pages', 'read', SPEC_PAGE_ID], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    if (result.status === 0 && typeof result.stdout === 'string') {
      const text = stripLineNumberPrefixes(result.stdout);
      if (extractRequirementIds(text).length > 0) return { text, origin: 'page' };
    }
  }
  const snapshotPath = path.resolve(root, opts.snapshot);
  if (!fs.existsSync(snapshotPath)) {
    throw new Error(`Spec snapshot not found at ${snapshotPath} and the page could not be read`);
  }
  return { text: fs.readFileSync(snapshotPath, 'utf8'), origin: 'snapshot' };
}

export interface CliOptions {
  ids: string[];
  allowlist: string;
  snapshot: string;
  offline: boolean;
  json: boolean;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = { ids: [], allowlist: DEFAULT_ALLOWLIST, snapshot: DEFAULT_SNAPSHOT, offline: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    if (arg === '--ids') opts.ids = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg.startsWith('--ids=')) opts.ids = arg.slice(6).split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--allowlist') opts.allowlist = next();
    else if (arg === '--snapshot') opts.snapshot = next();
    else if (arg === '--offline') opts.offline = true;
    else if (arg === '--json') opts.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

export function run(root: string, opts: CliOptions, log: (line: string) => void = console.log): number {
  const spec = loadSpec(root, { snapshot: opts.snapshot, offline: opts.offline });
  const ids = extractRequirementIds(spec.text);
  const allowlistPath = path.resolve(root, opts.allowlist);
  const allowlist = fs.existsSync(allowlistPath) ? parseAllowlist(fs.readFileSync(allowlistPath, 'utf8')) : [];
  const files = findTestFiles(root);
  const hitsByFile = scanTestFiles(root, files, ids);
  const report = buildReport({ ids, hitsByFile, allowlist, onlyIds: opts.ids });
  const ok = reportPasses(report);

  if (opts.json) {
    log(JSON.stringify({ origin: spec.origin, ok, ...report, rows: report.rows }, null, 2));
    return ok ? 0 : 1;
  }

  log(`Spec source: ${spec.origin === 'page' ? `page ${SPEC_PAGE_ID}` : opts.snapshot} (${ids.length} IDs); scanned ${files.length} test files`);
  log(formatTable(report));
  log('');
  const covered = report.rows.filter((r) => r.files.length > 0).length;
  log(`covered ${covered}/${report.rows.length}, allowlisted-missing ${report.allowlistedMissing.length}, MISSING ${report.missing.length}`);
  if (report.unknownAllowlist.length > 0) {
    log(`FAIL: allowlist entries that are not Spec IDs (typo?): ${report.unknownAllowlist.join(', ')}`);
  }
  if (report.staleAllowlist.length > 0) {
    log(`FAIL: tests now name these allowlisted IDs — remove them from ${opts.allowlist}: ${report.staleAllowlist.join(', ')}`);
  }
  if (report.missing.length > 0) {
    log(`FAIL: no live test names these IDs: ${report.missing.join(', ')}`);
  }
  log(ok ? 'spec-coverage: OK' : 'spec-coverage: FAILED');
  return ok ? 0 : 1;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    process.exit(run(root, parseArgs(process.argv.slice(2))));
  } catch (error) {
    console.error(`spec-coverage: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
