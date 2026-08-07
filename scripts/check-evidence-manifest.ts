/**
 * Evidence-manifest checker — the gate that keeps `docs/2.0-architecture/agent-sessions-evidence.json`
 * honest.
 *
 * A manifest that cites tests is only worth something if the citations are checked. Left
 * unchecked it rots in four specific ways, and this script fails the build on each:
 *
 *   1. MISSING_FILE   — a cited test file was moved or deleted.
 *   2. MISSING_TEST   — the file exists but no longer declares a test with the cited name
 *                       (someone reworded the `it(...)` and the citation silently stopped
 *                       pointing at anything).
 *   3. SKIPPED_TEST   — the cited test is declared with `.skip` / `.fixme` / `.todo`, or sits
 *                       inside a `describe.skip`. It looks like evidence and executes nothing.
 *   4. UNRUN_SUITE    — the cited test lives in a suite that NO CI job runs. This is the check
 *                       that would have caught the gap this manifest was born from: `apps/e2e`
 *                       had specs proving the epic's headline user stories and there was no e2e
 *                       job in `.github/workflows/` at all, so they only ever ran on a laptop.
 *
 * (3) and (4) are the interesting ones. A cited-but-skipped test and a cited-but-never-run
 * suite both read as "proven" on the page while proving nothing — the exact failure mode a
 * manifest is supposed to eliminate.
 *
 * UNRUN_SUITE is enforced against the workflow files themselves, not against a hardcoded list
 * here: every suite declares `ciEvidence`, a workflow path plus a literal substring that must
 * appear in it. Delete the e2e job and the substring vanishes and this script fails. Suites
 * whose runner needs each file named by hand (scripts/__tests__ — see the "Run backfill script
 * tests" step in ci.yml) additionally declare `requiresFileListedInCi`, which forces every
 * cited file's basename to appear literally in that workflow.
 *
 * Guarantees with no executing evidence are NOT omitted — they are recorded with
 * `"status": "gap"` and a `TODO(owner)` marker, and the checker requires that shape so a gap
 * cannot be quietly downgraded into a blank.
 *
 * Usage:  bun run scripts/check-evidence-manifest.ts [--manifest <path>] [--json]
 * Exit:   0 = every citation checks out; 1 = at least one violation.
 */
import fs from 'node:fs';
import path from 'node:path';

export type EvidenceStatus = 'proven' | 'gap';

export interface EvidenceCitation {
  /** Repo-relative path to the test file. */
  file: string;
  /** The exact string passed to it()/test()/describe() — not a paraphrase. */
  name: string;
  /** Which declared suite this file belongs to; must exist in `suites`. */
  suite: string;
}

export interface EvidenceSuite {
  /** How the suite executes, for humans reading the manifest. */
  runner: string;
  /** Repo-relative path prefixes whose test files belong to this suite. */
  pathPrefixes: string[];
  /** Workflow file + literal marker proving a CI job actually runs this suite. */
  ciEvidence: { workflow: string; contains: string };
  /**
   * Set for runners with a hand-maintained file list in the workflow (scripts/__tests__).
   * Every cited file's basename must then appear literally in the workflow file.
   */
  requiresFileListedInCi?: boolean;
}

export interface EvidenceGuarantee {
  id: string;
  /** The user-facing promise, phrased as something a user would notice breaking. */
  guarantee: string;
  status: EvidenceStatus;
  /** Present and non-empty when status is 'proven'. */
  evidence?: EvidenceCitation[];
  /** Present when status is 'gap'; must carry a TODO(owner) marker. */
  gap?: string;
  notes?: string;
}

export interface EvidenceManifest {
  suites: Record<string, EvidenceSuite>;
  guarantees: EvidenceGuarantee[];
}

export interface Violation {
  code: 'MISSING_FILE' | 'MISSING_TEST' | 'SKIPPED_TEST' | 'UNRUN_SUITE' | 'MALFORMED';
  guaranteeId: string;
  detail: string;
}

/** A test/describe declaration recovered from a spec file. */
export interface Declaration {
  name: string;
  /** True when the declaration itself, or any enclosing describe, is skipped. */
  skipped: boolean;
  /** What made it skipped, for the error message. */
  skipReason?: string;
  /** The name came from a template literal with substitutions. */
  templated: boolean;
}

const SKIP_MODIFIERS = new Set(['skip', 'fixme', 'todo']);

/**
 * Strip strings, template literals and comments to a same-length blank-filled copy, so brace
 * counting for describe nesting never trips over a `{` inside a test name or a comment. Keeping
 * the length identical means offsets computed on the stripped copy still address the original.
 */
export function blankOutLiteralsAndComments(source: string): string {
  const out = source.split('');
  let i = 0;
  const blankTo = (end: number) => {
    for (let j = i; j < end && j < out.length; j++) if (out[j] !== '\n') out[j] = ' ';
  };
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blankTo(stop);
      i = stop;
    } else if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blankTo(stop);
      i = stop;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === quote) break;
        j++;
      }
      const stop = Math.min(j + 1, source.length);
      // Keep the quotes themselves so the declaration scanner can still find them.
      i += 1;
      blankTo(stop - 1);
      i = stop;
    } else {
      i++;
    }
  }
  return out.join('');
}

/**
 * Read the literal (or template) string a test/describe was declared with, starting at the
 * opening parenthesis. Returns null when the first argument is not a string — which is how
 * `test.use({...})`, `test.setTimeout(120_000)` and `test.beforeEach(fn)` get ignored.
 */
function readFirstStringArg(
  source: string,
  parenIndex: number
): { value: string; templated: boolean } | null {
  let i = parenIndex + 1;
  while (i < source.length && /\s/.test(source[i])) i++;
  const quote = source[i];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let value = '';
  let templated = false;
  let j = i + 1;
  while (j < source.length) {
    const ch = source[j];
    if (ch === '\\') {
      value += source[j + 1];
      j += 2;
      continue;
    }
    if (ch === quote) break;
    if (quote === '`' && ch === '$' && source[j + 1] === '{') {
      templated = true;
      const close = source.indexOf('}', j + 2);
      if (close === -1) break;
      value += '${}';
      j = close + 1;
      continue;
    }
    value += ch;
    j++;
  }
  return { value, templated };
}

/**
 * Recover every test/it/describe declaration in a source file, with skip state that accounts
 * for enclosing `describe.skip` blocks.
 */
export function parseDeclarations(source: string): Declaration[] {
  const stripped = blankOutLiteralsAndComments(source);
  const declPattern = /\b(test|it|describe)((?:\s*\.\s*[A-Za-z]+)*)\s*\(/g;
  interface Frame {
    depth: number;
    skipped: boolean;
    reason: string;
  }
  const describeStack: Frame[] = [];
  const declarations: Declaration[] = [];

  // Precompute brace depth at every offset from the literal-free copy.
  const depthAt = new Int32Array(stripped.length + 1);
  let depth = 0;
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}') depth--;
    depthAt[i] = depth;
  }
  depthAt[stripped.length] = depth;

  let match: RegExpExecArray | null;
  while ((match = declPattern.exec(stripped)) !== null) {
    const kind = match[1];
    const modifiers = (match[2] ?? '')
      .split('.')
      .map((m) => m.trim())
      .filter(Boolean);
    const parenIndex = declPattern.lastIndex - 1;
    const arg = readFirstStringArg(source, parenIndex);
    if (!arg) continue; // not a declaration: test.use / setTimeout / hooks

    const here = depthAt[parenIndex];
    while (describeStack.length > 0 && describeStack[describeStack.length - 1].depth >= here) {
      describeStack.pop();
    }
    const ownSkip = modifiers.find((m) => SKIP_MODIFIERS.has(m));
    const enclosing = describeStack.find((f) => f.skipped);

    if (kind === 'describe') {
      describeStack.push({
        depth: here,
        skipped: Boolean(ownSkip) || Boolean(enclosing),
        reason: ownSkip ? `describe.${ownSkip}` : (enclosing?.reason ?? ''),
      });
    }
    declarations.push({
      name: arg.value,
      templated: arg.templated,
      skipped: Boolean(ownSkip) || Boolean(enclosing),
      skipReason: ownSkip ? `${kind}.${ownSkip}` : enclosing?.reason,
    });
  }
  return declarations;
}

/** A cited name matches a templated declaration when the non-placeholder parts line up. */
function matchesDeclaration(cited: string, declaration: Declaration): boolean {
  if (!declaration.templated) return declaration.name === cited;
  const pattern = declaration.name
    .split('${}')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.+');
  return new RegExp(`^${pattern}$`).test(cited);
}

function suiteForFile(manifest: EvidenceManifest, file: string): string | null {
  for (const [id, suite] of Object.entries(manifest.suites)) {
    if (suite.pathPrefixes.some((prefix) => file.startsWith(prefix))) return id;
  }
  return null;
}

export function checkManifest(manifest: EvidenceManifest, repoRoot: string): Violation[] {
  const violations: Violation[] = [];
  const workflowCache = new Map<string, string>();
  const readWorkflow = (rel: string): string => {
    if (!workflowCache.has(rel)) {
      const abs = path.join(repoRoot, rel);
      workflowCache.set(rel, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '');
    }
    return workflowCache.get(rel)!;
  };

  for (const guarantee of manifest.guarantees) {
    const { id, status, evidence, gap } = guarantee;

    if (status === 'gap') {
      // A gap must stay loudly a gap: an owner marker, and no citations masquerading as proof.
      if (!gap || !/TODO\([^)]+\)/.test(gap)) {
        violations.push({
          code: 'MALFORMED',
          guaranteeId: id,
          detail: `status "gap" requires a \`gap\` string carrying a TODO(owner) marker`,
        });
      }
      continue;
    }

    if (!evidence || evidence.length === 0) {
      violations.push({
        code: 'MALFORMED',
        guaranteeId: id,
        detail: `status "proven" requires at least one evidence citation (use status "gap" instead)`,
      });
      continue;
    }

    for (const citation of evidence) {
      const suite = manifest.suites[citation.suite];
      if (!suite) {
        violations.push({
          code: 'MALFORMED',
          guaranteeId: id,
          detail: `cites unknown suite "${citation.suite}" for ${citation.file}`,
        });
        continue;
      }

      const declaredSuite = suiteForFile(manifest, citation.file);
      if (declaredSuite !== citation.suite) {
        violations.push({
          code: 'MALFORMED',
          guaranteeId: id,
          detail: `${citation.file} is cited under suite "${citation.suite}" but its path resolves to ${declaredSuite ? `"${declaredSuite}"` : 'no declared suite'}`,
        });
        continue;
      }

      // UNRUN_SUITE: does a CI job actually execute this suite?
      const workflow = readWorkflow(suite.ciEvidence.workflow);
      if (!workflow.includes(suite.ciEvidence.contains)) {
        violations.push({
          code: 'UNRUN_SUITE',
          guaranteeId: id,
          detail: `suite "${citation.suite}" claims to run in ${suite.ciEvidence.workflow} but the marker \`${suite.ciEvidence.contains}\` is not there — no CI job runs ${citation.file}`,
        });
        continue;
      }
      if (suite.requiresFileListedInCi && !workflow.includes(path.basename(citation.file))) {
        violations.push({
          code: 'UNRUN_SUITE',
          guaranteeId: id,
          detail: `${citation.file} is not named in the hand-maintained list in ${suite.ciEvidence.workflow}; that runner only runs files listed there`,
        });
        continue;
      }

      // MISSING_FILE
      const abs = path.join(repoRoot, citation.file);
      if (!fs.existsSync(abs)) {
        violations.push({
          code: 'MISSING_FILE',
          guaranteeId: id,
          detail: `cited test file does not exist: ${citation.file}`,
        });
        continue;
      }

      // MISSING_TEST / SKIPPED_TEST
      const declarations = parseDeclarations(fs.readFileSync(abs, 'utf8'));
      const matches = declarations.filter((d) => matchesDeclaration(citation.name, d));
      if (matches.length === 0) {
        violations.push({
          code: 'MISSING_TEST',
          guaranteeId: id,
          detail: `${citation.file} declares no test named "${citation.name}"`,
        });
        continue;
      }
      const skipped = matches.filter((m) => m.skipped);
      if (skipped.length === matches.length) {
        violations.push({
          code: 'SKIPPED_TEST',
          guaranteeId: id,
          detail: `"${citation.name}" in ${citation.file} is skipped (${skipped[0].skipReason}) — it cites as evidence but executes nothing`,
        });
      }
    }
  }
  return violations;
}

export function loadManifest(manifestPath: string): EvidenceManifest {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as EvidenceManifest;
}

function main(): void {
  const args = process.argv.slice(2);
  const manifestIndex = args.indexOf('--manifest');
  const repoRoot = path.resolve(__dirname, '..');
  const manifestPath =
    manifestIndex === -1
      ? path.join(repoRoot, 'docs/2.0-architecture/agent-sessions-evidence.json')
      : path.resolve(args[manifestIndex + 1]);

  const manifest = loadManifest(manifestPath);
  const violations = checkManifest(manifest, repoRoot);

  const proven = manifest.guarantees.filter((g) => g.status === 'proven').length;
  const gaps = manifest.guarantees.filter((g) => g.status === 'gap');

  if (args.includes('--json')) {
    console.log(JSON.stringify({ violations, proven, gaps: gaps.length }, null, 2));
  } else {
    console.log(
      `evidence manifest: ${manifest.guarantees.length} guarantees — ${proven} proven, ${gaps.length} recorded as gaps`
    );
    for (const gap of gaps) console.log(`  gap  ${gap.id}: ${gap.gap}`);
    for (const violation of violations) {
      console.error(`  FAIL [${violation.code}] ${violation.guaranteeId}: ${violation.detail}`);
    }
  }

  if (violations.length > 0) {
    console.error(`\n${violations.length} evidence-manifest violation(s).`);
    process.exit(1);
  }
  console.log('evidence manifest OK');
}

if (require.main === module) main();
