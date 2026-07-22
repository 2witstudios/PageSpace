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
import type { MachineNodeHandle, MachineNodeTarget } from '@pagespace/lib/services/machines/machine-pane-binding';
import type { MachineRef } from '@/lib/repositories/page-agent-repository';
import { nodeTargetSchema } from '../sandbox-tools';

export type OpenResult =
  | {
      ok: true;
      userId: string;
      ctx: SandboxActorContext & { activeMachine: MachineRef };
      /** The machine-tree node this call resolved to; its `cwd` is the default working directory. */
      node?: MachineNodeHandle;
    }
  | { ok: false; error: { success: false; error: string } };

/**
 * The effect seams the generator injects. Built inside createSandboxGitTools so
 * they close over the factory deps; rows themselves stay pure data.
 */
export interface GeneratorSeams {
  open: (options: unknown, target?: MachineNodeTarget) => Promise<OpenResult>;
  git: (cmd: 'git' | 'gh', args: string[], ctx: SandboxActorContext, cwd?: string) => Promise<unknown>;
  withToken: (
    options: unknown,
    target: MachineNodeTarget | undefined,
    run: (ctx: SandboxActorContext, token: string, node?: MachineNodeHandle) => Promise<unknown>,
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

function targetOf(input: unknown): MachineNodeTarget | undefined {
  return (input as { target?: MachineNodeTarget } | null | undefined)?.target;
}

/**
 * Direct child addressing for ALL 56 git/gh tools, added in ONE place: every
 * row's object schema gains the same optional `target`, so a bound
 * conversation can aim any git command at a project or branch beneath it. Rows
 * stay pure data — none of them knows the machine tree exists.
 */
function withNodeTarget(schema: z.ZodTypeAny): z.ZodTypeAny {
  // Loud, at factory-construction time: silently returning the schema
  // unchanged would ship a git tool that LOOKS like every other one but
  // ignores `target` — a row added later with a wrapped schema would lose
  // node addressing with no signal anywhere.
  if (!(schema instanceof z.ZodObject)) {
    throw new Error('sandbox-git tool schemas must be plain z.object(...) so they can carry `target` node addressing');
  }
  return schema.extend({ target: nodeTargetSchema.optional() });
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
    const schemaWithTarget = withNodeTarget(row.schema);
    const inputSchema = validate
      ? schemaWithTarget.superRefine((val: unknown, ctx: z.RefinementCtx) => {
          const result = validate(val);
          if (!result.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.error });
        })
      : schemaWithTarget;

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
      //    An explicit `cwd` still wins; absent one, the command runs at the
      //    RESOLVED NODE's checkout (the bound node, or the one `target`
      //    addressed) instead of silently falling back to the machine root.
      const target = targetOf(input);
      if (row.exec === 'local') {
        const opened = await seams.open(options, target);
        if (!opened.ok) return opened.error;
        return seams.git(row.cmd, built.args, opened.ctx, cwdOf(input) ?? opened.node?.cwd);
      }
      return seams.withToken(options, target, (ctx, token, node) =>
        seams.gitR(row.cmd, built.args, ctx, token, cwdOf(input) ?? node?.cwd),
      );
    };

    out[row.key] = tool({
      description: row.description,
      inputSchema: inputSchema as z.ZodTypeAny,
      execute,
    });
  }

  return out;
}
