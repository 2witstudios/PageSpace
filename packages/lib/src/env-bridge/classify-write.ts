/**
 * Is this file write one the owner should look at before it lands?
 * (Hardening A, leaf A2.)
 *
 * WHY THIS EXISTS. The bridge's two tiers rest on `exec` being the dangerous
 * op: a command needs the owner's click (Tier B), while file writes inside a
 * declared root run headless (Tier A). That is not true on its own, because
 * confinement answers WHERE a write may land and never WHAT it says. An agent
 * that writes `.git/hooks/pre-commit` with mode 0o755 inside the enrolled root
 * has broken nothing and stolen nothing — and the owner's next ordinary
 * `git commit` runs it as them, with no click anywhere. This module is what
 * lets `decideExecution` see that coming.
 *
 * ESCALATE, DO NOT REFUSE. A sensitive write becomes an `ask` — the same card
 * `exec` already uses — never a denial. Ordinary writes stay headless, so no
 * workflow breaks; and because a false positive costs one click rather than a
 * breach, this classifier may be generous. A refusal list would have to be
 * COMPLETE to be safe, and it never can be.
 *
 * WHAT IT DOES NOT DO — the honest limit, repeated in the posture doc. A write
 * to ordinary source code that the owner later builds or runs is still
 * execution, and no list of filenames changes that. This raises the cost and
 * puts a human in front of the obvious vectors; it is not a boundary. Only OS
 * confinement would be one.
 *
 * MATCHING RULES.
 *   - By path SEGMENT, never substring: `my-package.json.bak` and `notMakefile`
 *     are ordinary files with unlucky names.
 *   - Case-INSENSITIVELY. macOS (by default) and Windows resolve `MAKEFILE` and
 *     `Makefile` to the same file, so a case-sensitive match would be a hole on
 *     exactly the platforms most owners run. On a case-sensitive filesystem the
 *     cost of the same rule is one extra click on a file genuinely named
 *     `MAKEFILE` — the trade this whole module is built on.
 *   - Path reasons are checked before `executable_bit`, so the owner is told
 *     the most specific true thing about the file ("this is a git hook", not
 *     "this is executable").
 *
 * Pure and total: plain data in, a closed union out. No I/O, no clock, no
 * throw — the path comes off the wire.
 */

/** Why a write was escalated, in the order `classifyWrite` checks them. */
export const SENSITIVE_WRITE_REASONS = ['vcs_metadata', 'shell_startup', 'build_or_task', 'package_manifest', 'ci_config', 'tool_config', 'executable_bit'] as const;
export type SensitiveWriteReason = (typeof SENSITIVE_WRITE_REASONS)[number];

export type WriteClassification = { readonly sensitive: false } | { readonly sensitive: true; readonly reason: SensitiveWriteReason };

export interface ClassifyWriteInput {
  /** The CONFINED real path the runner would write — never the path as requested. */
  readonly path: string;
  /** The POSIX mode requested for it, or `null` when the request named none. */
  readonly mode: number | null;
}

/** Directories whose contents are VCS internals: hooks, config, filters. Nothing legitimate needs an agent in here. */
const VCS_DIRS = new Set(['.git', '.hg', '.svn']);
/** Read by every login or interactive shell — the classic persistence target. */
const SHELL_STARTUP = new Set(['.bashrc', '.zshrc', '.zshenv', '.profile', '.bash_profile', '.zprofile', '.envrc']);
/** Files an editor or a developer runs by name, whose contents ARE commands. */
const BUILD_OR_TASK = new Set(['makefile', 'gnumakefile', 'justfile', 'rakefile']);
/** Editor/IDE directories whose files configure tasks that run on open or on save. */
const TASK_DIRS = new Set(['.idea']);
/** Manifests that all carry script or build hooks (`scripts`, `build.rs`, `setup.py` itself). */
const PACKAGE_MANIFESTS = new Set(['package.json', 'cargo.toml', 'pyproject.toml', 'setup.py', 'gemfile', 'composer.json']);
/** CI definitions: code that runs on a push, off this machine but as this owner. */
const CI_DIRS = new Set(['.circleci']);
const CI_FILES = new Set(['.gitlab-ci.yml']);
/** Configuration that hands another tool a command to run (filter drivers, hooks, test fixtures). */
const TOOL_CONFIG = new Set(['.pre-commit-config.yaml', '.gitattributes', '.gitmodules', 'conftest.py']);

/** Any executable bit — owner, group or other. */
const EXECUTABLE_BITS = 0o111;

const sensitive = (reason: SensitiveWriteReason): WriteClassification => ({ sensitive: true, reason });

/** Lowercased, empty segments dropped (`a//b` and a trailing slash are the same path). */
function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0).map((segment) => segment.toLowerCase());
}

/** Is `first` immediately followed by `second` anywhere in the path? */
function hasAdjacent(segments: readonly string[], first: string, second: string): boolean {
  for (let i = 0; i + 1 < segments.length; i += 1) if (segments[i] === first && segments[i + 1] === second) return true;
  return false;
}

/**
 * Classify one written file.
 * @returns `{ sensitive: false }` for an ordinary write (it runs headless), or
 * the single most specific reason the owner should be asked about it.
 */
export function classifyWrite(input: ClassifyWriteInput): WriteClassification {
  const segments = segmentsOf(input.path);
  const name = segments[segments.length - 1];

  if (segments.some((segment) => VCS_DIRS.has(segment))) return sensitive('vcs_metadata');
  if (name !== undefined && SHELL_STARTUP.has(name)) return sensitive('shell_startup');
  if (name !== undefined && BUILD_OR_TASK.has(name)) return sensitive('build_or_task');
  if (segments.some((segment) => TASK_DIRS.has(segment)) || hasAdjacent(segments, '.vscode', 'tasks.json')) return sensitive('build_or_task');
  if (name !== undefined && PACKAGE_MANIFESTS.has(name)) return sensitive('package_manifest');
  if (segments.some((segment) => CI_DIRS.has(segment)) || hasAdjacent(segments, '.github', 'workflows') || (name !== undefined && CI_FILES.has(name))) return sensitive('ci_config');
  if (name !== undefined && TOOL_CONFIG.has(name)) return sensitive('tool_config');
  if (input.mode !== null && (input.mode & EXECUTABLE_BITS) !== 0) return sensitive('executable_bit');
  return { sensitive: false };
}

/** One sensitive file in a write request: which file, and why the owner is being asked. */
export interface SensitiveWrite {
  readonly path: string;
  readonly reason: SensitiveWriteReason;
}

/**
 * Every sensitive file in one `fs_write` request, in path order — the answer
 * both the escalation (`decideExecution`) and the approval subject
 * (`approvalSubjects`) are derived from, so the two can never disagree about
 * what "sensitive" meant for a given request.
 *
 * `modes` is index-aligned with `paths` (A1); a path with no entry is treated
 * as having named no mode.
 */
export function sensitiveWrites(paths: readonly string[], modes: readonly (number | null)[] | undefined): SensitiveWrite[] {
  const found: SensitiveWrite[] = [];
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index] as string;
    const verdict = classifyWrite({ path, mode: modes?.[index] ?? null });
    if (verdict.sensitive) found.push({ path, reason: verdict.reason });
  }
  return found;
}
