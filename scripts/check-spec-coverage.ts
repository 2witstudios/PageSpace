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
 *   3. Walk `packages/`, `apps/`, `scripts/`, and `infrastructure/` for every `test-results/*.json`
 *      file (plus the root-extracted `playwright-results.json`) and collect every test's own
 *      title, describe titles, and whether it `passed` — Vitest's and Playwright's own JSON
 *      reporters, uploaded as CI artifacts by ci.yml's jobs. Only ci.yml's runs reach this gate;
 *      suites only security.yml runs never do (see `securityOnlyWarnings`).
 *   4. Print a table ID → files, and exit non-zero listing every ID that no PASSING test names
 *      (see `hitsFromTestOutcomes` for how describe-level IDs count, and `failsModifierFiles`
 *      for why `.fails` is banned in contributing files).
 *
 * COVERAGE SOURCE — read what CI actually RAN, not what the source merely names. Earlier
 * revisions statically parsed test source with the TypeScript compiler API to decide which
 * `it`/`test`/`describe` declarations execute unconditionally. Every fix (regex → brace-bounded
 * regex → a real AST walk → fail-closed on runIf/skipIf/runtime-skip-guards/unknown modifiers)
 * uncovered another shape the walk could not see through — a test gated behind an `if`/`&&`/
 * ternary, one only reachable through a helper function, vitest's `ctx.skip()`/a destructured
 * `skip`, `test.fixme(cond)`, a file-top-level `test.skip()` — because "does this test execute"
 * is a RUNTIME question in general, not a static one. No static walk closes that gap; only the
 * test runner itself can say what ran. So coverage is never decided from test SOURCE: an ID
 * counts only when a test named with it reports `passed` in a real CI run.
 * See `loadTestOutcomes` / `parseVitestJsonReport` / `parsePlaywrightJsonReport`.
 *
 * If no Playwright results are found (the e2e job did not run, was skipped, or failed before
 * uploading), the gate says so explicitly on stdout — it does not fail mysteriously, and it does
 * not silently treat e2e-only IDs as covered. It fails closed by construction: no Playwright
 * results means no Playwright-sourced hits, so an e2e-only ID reports MISSING (or
 * allowlisted-missing) exactly as if no test for it had ever run.
 *
 * The allowlist (`scripts/spec-coverage-allowlist.txt`) holds IDs not yet in scope. EVERY ID
 * starts allowlisted; a lane removes its IDs from the file in the same PR that lands the tests.
 * The gate is a ratchet in both directions: an allowlisted ID that a test now names FAILS with
 * "remove it from the allowlist", so the file shrinks as work lands (an ID goes back only when a
 * review shows its covering test does not prove it; see the allowlist header), and an allowlisted
 * token that is not a Spec ID FAILS as a typo.
 *
 * Usage:  bun run scripts/check-spec-coverage.ts [--ids MON-2,X-6] [--allowlist <path>]
 *                [--snapshot <path>] [--offline] [--json]
 *   --ids       check only these IDs (comma-separated); the allowlist still applies
 *   --offline   never call the pagespace CLI; read the snapshot only (what CI does)
 *   --json      machine-readable report on stdout instead of the table
 * Exit:   0 = every in-scope ID is named by at least one passing test; 1 = at least one gap
 *         (or a stale / unknown allowlist entry, or the Spec or the test results could not be
 *         loaded).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SPEC_PAGE_ID = 'drc7x34unhc0ty1dc0u1j3gy';
export const DEFAULT_SNAPSHOT = 'docs/specs/organizations-wallets.md';
export const DEFAULT_ALLOWLIST = 'scripts/spec-coverage-allowlist.txt';
/** Roots walked for `test-results/*.json` — every place a JSON test reporter can write in this repo. */
export const RESULT_SCAN_ROOTS = ['packages', 'apps', 'scripts', 'infrastructure'];
/**
 * Result files read from the repo ROOT, where CI's `actions/download-artifact` extracts them. An
 * artifact uploaded from a single file path (the e2e job's
 * `apps/e2e/test-results/playwright-results.json`) is rooted at that file's own directory, so it
 * extracts as `./playwright-results.json` — not under any `test-results/` dir the walk above sees.
 */
const ROOT_RESULT_FILES = ['playwright-results.json'];

/** One requirement ID as it appears in the Spec, e.g. "MON-2". */
export const REQUIREMENT_ID_PATTERN = /\b(ORG|DRV|SEAT|WAL|MON|SPEND|POL|SEC|AUD|UI|X)-\d+\b/g;

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', 'coverage', '.turbo', '.git', 'build', 'out']);

export interface CoverageRow {
  id: string;
  /** Repo-relative test files with a PASSING test whose name carries the ID. */
  files: string[];
  allowlisted: boolean;
}

export interface CoverageReport {
  rows: CoverageRow[];
  /** IDs with no passing test and not allowlisted — the gate failures. */
  missing: string[];
  /** IDs with no passing test that the allowlist excuses. */
  allowlistedMissing: string[];
  /** Allowlisted IDs that a passing test now names — must be removed from the allowlist. */
  staleAllowlist: string[];
  /** Allowlist tokens that are not IDs in the Spec. */
  unknownAllowlist: string[];
  /** Number of distinct files with at least one passing hit. */
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
  /** Repo-relative test file → the IDs a passing test in it names. */
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
// CI test-results parsing — Vitest's and Playwright's own JSON reporters
// ---------------------------------------------------------------------------

export interface TestOutcome {
  runner: 'vitest' | 'playwright';
  /** Repo-relative (or reporter-relative) source file the test belongs to. */
  file: string;
  /** The test's OWN title (Vitest `title`, Playwright spec `title`). */
  title: string;
  /** Enclosing describe titles (Vitest `ancestorTitles`) or suite titles (Playwright). */
  ancestors: string[];
  /** Reported `passed` (Vitest) / some result `passed` (Playwright). Skipped, todo, failed: false. */
  passed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Vitest's built-in `json` reporter: `{ testResults: [{ name, assertionResults: [...] }] }`. */
export function isVitestJsonReport(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Array.isArray(value.testResults);
}

/** Playwright's built-in `json` reporter: `{ suites: [...], config, stats, ... }`. */
export function isPlaywrightJsonReport(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Array.isArray(value.suites) && !Array.isArray(value.testResults);
}

/** Every `assertionResults` entry, whatever its status, one row per (file, test). */
export function parseVitestJsonReport(report: unknown): TestOutcome[] {
  if (!isVitestJsonReport(report)) return [];
  const out: TestOutcome[] = [];
  for (const fileResult of report.testResults as unknown[]) {
    if (!isRecord(fileResult)) continue;
    const file = typeof fileResult.name === 'string' ? fileResult.name : undefined;
    const assertions = Array.isArray(fileResult.assertionResults) ? fileResult.assertionResults : [];
    for (const assertion of assertions) {
      if (!isRecord(assertion)) continue;
      const ancestors = Array.isArray(assertion.ancestorTitles)
        ? assertion.ancestorTitles.filter((t): t is string => typeof t === 'string')
        : [];
      const title =
        typeof assertion.title === 'string' ? assertion.title : typeof assertion.fullName === 'string' ? assertion.fullName : '';
      if (file && title) out.push({ runner: 'vitest', file, title, ancestors, passed: assertion.status === 'passed' });
    }
  }
  return out;
}

/**
 * Walks Playwright's `suites` tree (suites nest suites; a suite's own tests live in `specs`).
 * Each spec keeps its own title and every ancestor suite title separately. A spec is `passed`
 * only when at least one of its `tests[].results[]` reports `status: 'passed'` — a retry that
 * eventually passed still counts; one that never did, does not. (`test.fail()` reports its
 * results as `failed`, so Playwright has no equivalent of Vitest's `it.fails` trap.)
 */
export function parsePlaywrightJsonReport(report: unknown): TestOutcome[] {
  if (!isPlaywrightJsonReport(report)) return [];
  const out: TestOutcome[] = [];

  const walkSuite = (suite: unknown, ancestors: string[], inheritedFile: string | undefined): void => {
    if (!isRecord(suite)) return;
    const title = typeof suite.title === 'string' ? suite.title : undefined;
    const file = typeof suite.file === 'string' ? suite.file : inheritedFile;
    const nextAncestors = title ? [...ancestors, title] : ancestors;

    for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
      if (!isRecord(spec)) continue;
      const specTitle = typeof spec.title === 'string' ? spec.title : '';
      const specFile = typeof spec.file === 'string' ? spec.file : file;
      const tests = Array.isArray(spec.tests) ? spec.tests : [];
      const passed = tests.some(
        (t) =>
          isRecord(t) &&
          Array.isArray(t.results) &&
          t.results.some((r) => isRecord(r) && r.status === 'passed'),
      );
      if (specFile && specTitle) {
        out.push({ runner: 'playwright', file: specFile, title: specTitle, ancestors: nextAncestors, passed });
      }
    }

    for (const nested of Array.isArray(suite.suites) ? suite.suites : []) walkSuite(nested, nextAncestors, file);
  };

  for (const suite of report.suites as unknown[]) walkSuite(suite, [], undefined);
  return out;
}

function toRepoRelative(root: string, file: string): string {
  return path.isAbsolute(file) ? path.relative(root, file) : file;
}

/** Every `test-results/*.json` file under the result-scan roots, plus any root-level CI artifact file, repo-relative, sorted. */
export function findResultFiles(root: string, roots: readonly string[] = RESULT_SCAN_ROOTS): string[] {
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
      } else if (entry.isFile() && entry.name.endsWith('.json') && path.basename(dir) === 'test-results') {
        found.push(path.relative(root, path.join(dir, entry.name)));
      }
    }
  };
  for (const r of roots) walk(path.join(root, r));
  for (const name of ROOT_RESULT_FILES) {
    if (fs.statSync(path.join(root, name), { throwIfNoEntry: false })?.isFile()) found.push(name);
  }
  return found.sort();
}

export interface LoadedResults {
  tests: TestOutcome[];
  resultFiles: string[];
  sawVitest: boolean;
  sawPlaywright: boolean;
}

/**
 * Reads every `test-results/*.json` file found under the result-scan roots and parses each as
 * whichever reporter shape it matches. A file that is neither shape (or fails to parse as JSON)
 * is a hard error — a malformed or unexpected result file must never be silently ignored, since
 * that is exactly the kind of gap that lets an ID pass without ever having run.
 */
export function loadTestOutcomes(root: string): LoadedResults {
  const resultFiles = findResultFiles(root);
  const tests: TestOutcome[] = [];
  let sawVitest = false;
  let sawPlaywright = false;

  for (const relFile of resultFiles) {
    const absFile = path.join(root, relFile);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(absFile, 'utf8'));
    } catch (error) {
      throw new Error(`Could not parse test-results JSON at ${relFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (isVitestJsonReport(parsed)) {
      sawVitest = true;
      for (const t of parseVitestJsonReport(parsed)) tests.push({ ...t, file: toRepoRelative(root, t.file) });
    } else if (isPlaywrightJsonReport(parsed)) {
      sawPlaywright = true;
      for (const t of parsePlaywrightJsonReport(parsed)) tests.push({ ...t, file: toRepoRelative(root, t.file) });
    } else {
      throw new Error(`${relFile} is neither a Vitest nor a Playwright JSON reporter file — unrecognized shape`);
    }
  }

  return { tests, resultFiles, sawVitest, sawPlaywright };
}

/**
 * Repo-relative file → the IDs its tests cover. An ID counts for a file when either:
 *   - a PASSING test names it in its OWN title, or
 *   - it is named by an enclosing describe title AND every test in that file under a describe
 *     naming it passed.
 * The second rule exists because a describe title is shared by every test under it: without it,
 * `describe('MON-2 …')` with a skipped real check and a passing trivial sibling would count MON-2
 * as covered by a test that never ran.
 */
export function hitsFromTestOutcomes(tests: readonly TestOutcome[], ids: readonly string[]): Map<string, Set<string>> {
  const hits = new Map<string, Set<string>>();
  const add = (file: string, id: string): void => {
    const existing = hits.get(file) ?? new Set<string>();
    existing.add(id);
    hits.set(file, existing);
  };
  // `${file}\0${id}` → whether every test under a describe naming that id passed.
  const describeGroups = new Map<string, { file: string; id: string; allPassed: boolean }>();
  for (const t of tests) {
    if (t.passed) for (const id of idsNamedBy([t.title], ids)) add(t.file, id);
    for (const id of idsNamedBy(t.ancestors, ids)) {
      const key = `${t.file}\0${id}`;
      const group = describeGroups.get(key) ?? { file: t.file, id, allPassed: true };
      group.allPassed &&= t.passed;
      describeGroups.set(key, group);
    }
  }
  for (const g of describeGroups.values()) if (g.allPassed) add(g.file, g.id);
  return hits;
}

/**
 * Vitest reports `it.fails(...)` as `passed` exactly when its body FAILS, and its JSON reporter
 * carries no flag saying so. So any Vitest file that contributes an ID must not use `.fails` at
 * all (a whole-file text check — deliberately blunt, it can only fail closed). An unreadable
 * contributing file is an error, never a pass.
 */
export function failsModifierFiles(
  root: string,
  hitsByFile: ReadonlyMap<string, ReadonlySet<string>>,
  tests: readonly TestOutcome[] = [],
): string[] {
  const playwrightFiles = new Set(tests.filter((t) => t.runner === 'playwright').map((t) => t.file));
  const flagged: string[] = [];
  for (const [file, idsInFile] of hitsByFile) {
    if (idsInFile.size === 0 || playwrightFiles.has(file)) continue;
    let source: string;
    try {
      source = fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      throw new Error(`Cannot read ${file} to check it for \`.fails\` — a file that contributes Spec IDs must be readable`);
    }
    if (/\.fails\b/.test(source)) flagged.push(file);
  }
  return flagged.sort();
}

const SECURITY_WORKFLOW = '.github/workflows/security.yml';

/**
 * Only ci.yml's runners upload results to this gate. `security.yml` runs some suites (its
 * `test:db` steps) that no ci.yml job runs, so a Spec ID named only there always shows unmet.
 * For every unmet ID named in such a file, returns a WARNING line saying exactly that.
 */
export function securityOnlyWarnings(root: string, tests: readonly TestOutcome[], unmetIds: readonly string[]): string[] {
  let workflow: string;
  try {
    workflow = fs.readFileSync(path.join(root, SECURITY_WORKFLOW), 'utf8');
  } catch {
    return [];
  }
  const ranInCi = new Set(tests.map((t) => t.file));
  const files = new Set<string>();
  const invocation = /--filter\s+'([^']+)'\s+test(?::\w+)?\s+--((?:[ \t]+|\\\r?\n|[\w./-]+)*)/g;
  for (const m of workflow.matchAll(invocation)) {
    const pkg = m[1];
    const pkgDir = pkg.startsWith('@pagespace/') ? `packages/${pkg.slice('@pagespace/'.length)}` : `apps/${pkg}`;
    for (const arg of m[2].split(/[\s\\]+/)) {
      if (/\.(test|spec)\.tsx?$/.test(arg)) files.add(`${pkgDir}/${arg}`);
    }
  }
  const warnings: string[] = [];
  for (const file of [...files].sort()) {
    if (ranInCi.has(file)) continue;
    let source: string;
    try {
      source = fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      continue;
    }
    for (const id of idsNamedBy([source], unmetIds)) {
      warnings.push(
        `WARNING: ${id} is named in ${file}, which only security.yml runs — its results never reach this gate, so it cannot count. Run that test in a ci.yml job (or name ${id} in one that is).`,
      );
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Other IO edges
// ---------------------------------------------------------------------------

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

  const { tests, resultFiles, sawVitest, sawPlaywright } = loadTestOutcomes(root);
  if (resultFiles.length === 0) {
    throw new Error(
      'No test-results/*.json files found under packages/, apps/, scripts/, or infrastructure/ ' +
        '— nothing to check coverage against. Did the Unit Tests and E2E jobs run and upload ' +
        'their JSON reporter output before this gate ran?',
    );
  }

  const hitsByFile = hitsFromTestOutcomes(tests, ids);
  const report = buildReport({ ids, hitsByFile, allowlist, onlyIds: opts.ids });
  const failsFiles = failsModifierFiles(root, hitsByFile, tests);
  const securityWarnings = securityOnlyWarnings(root, tests, [...report.missing, ...report.allowlistedMissing]);
  const ok = reportPasses(report) && failsFiles.length === 0;

  if (opts.json) {
    log(JSON.stringify({ origin: spec.origin, ok, sawVitest, sawPlaywright, resultFiles: resultFiles.length, failsFiles, securityWarnings, ...report, rows: report.rows }, null, 2));
    return ok ? 0 : 1;
  }

  log(`Spec source: ${spec.origin === 'page' ? `page ${SPEC_PAGE_ID}` : opts.snapshot} (${ids.length} IDs)`);
  log(`Test results: ${resultFiles.length} file(s), ${tests.filter((t) => t.passed).length} passing of ${tests.length} test(s) parsed`);
  log('Coverage source: only test runs in ci.yml reach this gate (security.yml-only suites never do).');
  if (!sawVitest) {
    log('WARNING: no Vitest JSON results found — every unit/integration-covered ID will show as MISSING or allowlisted this run.');
  }
  if (!sawPlaywright) {
    log(
      'WARNING: no Playwright JSON results found (the e2e job did not run, was skipped, or failed ' +
        'before uploading) — every e2e-only ID will show as MISSING or allowlisted this run, ' +
        'fail-closed rather than silently counted as covered.',
    );
  }
  for (const w of securityWarnings) log(w);
  log(formatTable(report));
  log('');
  const covered = report.rows.filter((r) => r.files.length > 0).length;
  log(`covered ${covered}/${report.rows.length}, allowlisted-missing ${report.allowlistedMissing.length}, MISSING ${report.missing.length}`);
  if (report.unknownAllowlist.length > 0) {
    log(`FAIL: allowlist entries that are not Spec IDs (typo?): ${report.unknownAllowlist.join(', ')}`);
  }
  if (report.staleAllowlist.length > 0) {
    log(`FAIL: passing tests now name these allowlisted IDs — remove them from ${opts.allowlist}: ${report.staleAllowlist.join(', ')}`);
  }
  if (report.missing.length > 0) {
    log(`FAIL: no passing test names these IDs: ${report.missing.join(', ')}`);
  }
  if (failsFiles.length > 0) {
    log(`FAIL: these files contribute Spec IDs but use \`.fails\` (Vitest reports it as passed when its body fails): ${failsFiles.join(', ')}`);
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
