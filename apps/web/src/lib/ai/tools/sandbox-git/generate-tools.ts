/**
 * The single generator that turns declarative tool rows (tools/*.ts) into
 * AI-SDK tool() objects. This is now the ONE place that could violate the exec
 * contract, so it is exhaustively branch-tested (core/__tests__/generate-tools.test.ts):
 *   - cmd is always the row's literal 'git' | 'gh'
 *   - args are always the pure buildArgs string[] (nothing shell-interpolated)
 *   - open / withToken are the only effect seams; the seam is chosen by exec kind
 *   - each row's validator runs in BOTH the schema (superRefine) and execute
 */
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import type { GitToolRow } from './tools/types';
import type { SandboxActorContext } from '@pagespace/lib/services/sandbox/tool-runners';
import type { MachineRef } from '@/lib/repositories/page-agent-repository';

export type OpenResult =
  | { ok: true; userId: string; ctx: SandboxActorContext & { activeMachine: MachineRef } }
  | { ok: false; error: { success: false; error: string } };

/**
 * The effect seams the generator injects. Built inside createSandboxGitTools so
 * they close over the factory deps; rows themselves stay pure data.
 */
export interface GeneratorSeams {
  open: (options: unknown) => Promise<OpenResult>;
  git: (cmd: 'git' | 'gh', args: string[], ctx: SandboxActorContext, cwd?: string) => Promise<unknown>;
  withToken: (
    options: unknown,
    run: (ctx: SandboxActorContext, token: string) => Promise<unknown>,
  ) => Promise<unknown>;
  gitR: (
    cmd: 'git' | 'gh',
    args: string[],
    ctx: SandboxActorContext,
    token: string,
    cwd?: string,
  ) => Promise<unknown>;
}

/** SANDBOX_GIT_TOOL_NAMES is derived from the rows — never hand-maintained. */
export function deriveToolNames(rows: readonly GitToolRow[]): string[] {
  return rows.map((r) => r.key);
}

function cwdOf(input: unknown): string | undefined {
  return (input as { cwd?: string } | null | undefined)?.cwd;
}

export function generateSandboxGitTools(
  rows: readonly GitToolRow[],
  seams: GeneratorSeams,
): Record<string, Tool> {
  const out: Record<string, Tool> = {};

  for (const row of rows) {
    const validate = row.validate;

    // Wire the validator ONCE into the schema — the same function object runs in
    // execute below, so the schema and the defense-in-depth check can never drift.
    const inputSchema = validate
      ? row.schema.superRefine((val: unknown, ctx: z.RefinementCtx) => {
          const result = validate(val);
          if (!result.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.error });
        })
      : row.schema;

    const execute = async (input: unknown, options: unknown) => {
      // 1. Pure precondition check BEFORE any sandbox is touched (fail-fast, no quota).
      if (validate) {
        const result = validate(input);
        if (!result.ok) return { success: false as const, error: result.error };
      }
      // 2. Pure argv build — a path_escape denial is data, not an effect.
      const built = row.buildArgs(input);
      if ('error' in built) {
        return built.reason !== undefined
          ? { success: false as const, error: built.error, reason: built.reason }
          : { success: false as const, error: built.error };
      }
      // 3. Effect seam, chosen by exec kind. cmd is the row's literal; args string[].
      const cwd = cwdOf(input);
      if (row.exec === 'local') {
        const opened = await seams.open(options);
        if (!opened.ok) return opened.error;
        return seams.git(row.cmd, built.args, opened.ctx, cwd);
      }
      return seams.withToken(options, (ctx, token) => seams.gitR(row.cmd, built.args, ctx, token, cwd));
    };

    out[row.key] = tool({
      description: row.description,
      inputSchema: inputSchema as z.ZodTypeAny,
      execute,
    });
  }

  return out;
}
