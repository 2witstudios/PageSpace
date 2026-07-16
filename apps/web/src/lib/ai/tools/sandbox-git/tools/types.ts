/**
 * The declarative tool-table row: every sandbox git/gh tool is one of these data
 * rows. A single generator (../generate-tools.ts) turns rows into AI-SDK tool()
 * objects, wiring each row's validator once into BOTH the zod schema and the
 * execute path so validator drift is structurally impossible. Adding a tool is
 * adding a row — the file cannot re-grow into 1775 lines of hand-written blocks.
 */
import type { z } from 'zod';
import type { ValidationResult } from '../core/validators';

export type GitCmd = 'git' | 'gh';
export type ExecKind = 'local' | 'token';
export type ToolGroup =
  | 'repo'
  | 'worktree'
  | 'history'
  | 'remote'
  | 'pr'
  | 'actions'
  | 'issues'
  | 'repos-search';

/**
 * A pure argv build result. Most tools always produce args; the two
 * destination-path tools (clone, init) may deny with `path_escape` — expressed
 * as data here so buildArgs stays pure (no thrown effects).
 */
export type BuildArgsResult = { args: string[] } | { error: string; reason?: 'path_escape' };

export interface GitToolRow {
  key: string;
  group: ToolGroup;
  cmd: GitCmd;
  exec: ExecKind;
  description: string;
  schema: z.ZodTypeAny;
  /** Pure precondition check — wired into the schema refine AND execute. */
  validate?: (input: unknown) => ValidationResult;
  /** Pure argv builder — never reaches for an effect. */
  buildArgs: (input: unknown) => BuildArgsResult;
}

/**
 * Type-safe row builder: ties `schema`, `validate` and `buildArgs` to the
 * schema's inferred input type at the definition site, then erases to the
 * untyped `GitToolRow` the registry array and generator consume. The single
 * `as unknown` here is the erasure boundary — no `any` leaks into callers.
 */
export function defineRow<S extends z.ZodTypeAny>(def: {
  key: string;
  group: ToolGroup;
  cmd: GitCmd;
  exec: ExecKind;
  description: string;
  schema: S;
  validate?: (input: z.infer<S>) => ValidationResult;
  buildArgs: (input: z.infer<S>) => BuildArgsResult;
}): GitToolRow {
  return def as unknown as GitToolRow;
}
