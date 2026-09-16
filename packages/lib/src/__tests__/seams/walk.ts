/**
 * Shared file walker for the seam guard tests in this directory.
 *
 * A seam guard is a test that greps the tree for a pattern that must only appear behind one
 * canonical module (Vision principle 2: "One canonical primitive per concept … a second path
 * is a bug"). Each guard measures today's violations, allowlists them by path with a TODO id,
 * and fails on any NEW file — and on any allowlisted file that no longer violates, so the
 * allowlist can only shrink.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root, resolved from this file's location (packages/lib/src/__tests__/seams). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', 'coverage', '.turbo', '.git', 'build', 'out']);
const SOURCE_FILE = /\.(ts|tsx)$/;
const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|mjs|cjs)$/;

/**
 * Every non-test file under `roots` whose basename matches `fileName` (repo-relative),
 * sorted, posix-separated. `__tests__` directories are skipped, as for source files.
 */
export function listFiles(roots: readonly string[], fileName: RegExp): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && entry.name !== '__tests__') walk(full);
      } else if (entry.isFile() && fileName.test(entry.name) && !TEST_FILE.test(entry.name)) {
        found.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
      }
    }
  };
  for (const root of roots) walk(path.join(REPO_ROOT, root));
  return found.sort();
}

/** Every non-test .ts/.tsx source file under `roots` (repo-relative), sorted, posix-separated. */
export function listSourceFiles(roots: readonly string[]): string[] {
  return listFiles(roots, SOURCE_FILE);
}

export interface Violation {
  file: string;
  line: number;
  text: string;
}

/** Lines in `file` (repo-relative) matching `pattern`, with block and whole-line comments removed. */
export function findViolations(file: string, pattern: RegExp): Violation[] {
  const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, ' '),
  );
  const out: Violation[] = [];
  source.split('\n').forEach((raw, i) => {
    const line = raw.replace(/^\s*\/\/.*$/, '');
    if (pattern.test(line)) out.push({ file, line: i + 1, text: raw.trim() });
  });
  return out;
}

export interface SeamResult {
  /** Files that violate and are not allowlisted — the failures. */
  newViolations: Violation[];
  /** Allowlisted files that no longer violate — remove them from the allowlist. */
  staleAllowlist: string[];
  /** Allowlisted files that still violate (informational). */
  allowedViolations: Violation[];
}

/**
 * Run a seam over the files. `allowlist` maps repo-relative path → TODO id explaining why it
 * is tolerated today. Exempt paths (the canonical home of the primitive) are skipped outright.
 */
export function runSeam(opts: {
  files: readonly string[];
  pattern: RegExp;
  exemptPrefixes: readonly string[];
  allowlist: Readonly<Record<string, string>>;
}): SeamResult {
  const newViolations: Violation[] = [];
  const allowedViolations: Violation[] = [];
  const stillViolating = new Set<string>();
  for (const file of opts.files) {
    if (opts.exemptPrefixes.some((p) => file.startsWith(p))) continue;
    const hits = findViolations(file, opts.pattern);
    if (hits.length === 0) continue;
    if (file in opts.allowlist) {
      stillViolating.add(file);
      allowedViolations.push(...hits);
    } else {
      newViolations.push(...hits);
    }
  }
  const staleAllowlist = Object.keys(opts.allowlist).filter((f) => !stillViolating.has(f)).sort();
  return { newViolations, staleAllowlist, allowedViolations };
}

export function describeViolations(violations: readonly Violation[]): string {
  return violations.map((v) => `  ${v.file}:${v.line}  ${v.text}`).join('\n');
}
