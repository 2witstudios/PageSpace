/**
 * Agent git/GitHub tools: all 56 tools running inside a sandbox.
 *
 * Pure factory — no DB imports, no Sprites SDK. Production wiring lives in
 * `sandbox-git-tools-runtime.ts`. Tools are declarative data rows in
 * `sandbox-git/tools/*` (pure core: refspec/push-guard, validators, arg builders,
 * per-subcommand command specs). One generator (`sandbox-git/generate-tools.ts`)
 * turns rows into AI-SDK tool() objects, wiring each row's validator once into
 * both the zod schema and the execute path. This shell only builds the effect
 * seams (open / withToken / git / gitR) and injects them into the generator.
 *
 * Each generated tool's execute handler:
 *   1. Validates input (defense-in-depth; schema validation happens at the AI layer).
 *   2. Builds argv from the pure command spec (may deny path_escape).
 *   3. Resolves the actor context + runs the call-time gate + resolves the ACTIVE
 *      machine (same gate as bash/writeFile/readFile).
 *   4. For remote/gh tools: pre-checks the GitHub token (fails fast, no quota).
 *   5. Delegates to `runGitInSandbox` with cmd + args[] (never sh -c).
 *
 * Security: cmd is always a literal ('git' or 'gh'). Args are string[]. No
 * shell interpolation is possible. Token is injected per-command by the
 * runner, never persisted.
 */

import type { Tool } from 'ai';
import type { SandboxActorContext } from '@pagespace/lib/services/sandbox/tool-runners';
import type { GitSandboxRunDeps } from '@pagespace/lib/services/sandbox/git-tool-runners';
import { runGitInSandbox } from '@pagespace/lib/services/sandbox/git-tool-runners';
import {
  machineAccessDeniedError,
  resolveActiveMachine,
  type MachineDirectoryDeps,
  type ResolveSandboxContext,
  type SandboxGate,
} from './sandbox-tools';
import type { MachineRef } from '@/lib/repositories/page-agent-repository';
import type { ToolExecutionContext } from '../core/types';
import {
  generateSandboxGitTools,
  deriveToolNames,
  type GeneratorSeams,
  type OpenResult,
} from './sandbox-git/generate-tools';
import { SANDBOX_GIT_TOOL_ROWS } from './sandbox-git/tools/registry';

// Tool names consumed by tool-filtering.ts to detect whether the sandbox git/gh
// toolkit is active. DERIVED from the tool rows — never hand-maintained — so a
// new row cannot drift from this export. Sync-checked against the factory's
// return keys in this file's own test suite.
export const SANDBOX_GIT_TOOL_NAMES: readonly string[] = deriveToolNames(SANDBOX_GIT_TOOL_ROWS);

export interface GitSandboxToolsDeps {
  gitRunDeps: GitSandboxRunDeps;
  resolveContext: ResolveSandboxContext;
  gate: SandboxGate;
  machines: MachineDirectoryDeps;
}

function readContext(options: unknown): ToolExecutionContext | undefined {
  return (options as { experimental_context?: ToolExecutionContext })?.experimental_context;
}

const NO_CONNECTION_ERROR = {
  success: false as const,
  error:
    'No GitHub connection found. Connect your GitHub account in Settings → Integrations to use remote git operations.',
  reason: 'error' as const,
};

export function createSandboxGitTools({ gitRunDeps, resolveContext, gate, machines }: GitSandboxToolsDeps): Record<string, Tool> {
  /**
   * Resolve context + gate check shared by every tool. Also resolves the
   * ACTIVE machine and threads it onto ctx — the same seam bash/file tools
   * use in sandbox-tools.ts, so git commands run against the same active
   * machine as the rest of the terminal tool group.
   */
  const open = async (options: unknown): Promise<OpenResult> => {
    const rawContext = readContext(options);
    const ctx = await resolveContext(rawContext);
    if ('error' in ctx) return { ok: false, error: { success: false, error: ctx.error } };
    const decision = await gate(ctx);
    if (!decision.ok) return { ok: false, error: { success: false, error: decision.error } };
    // resolveActiveMachine re-verifies access on EVERY call, mirroring
    // sandbox-tools.ts — the actual execution boundary must not trust a
    // machine reference that was accessible only at a past switch_machine
    // call (OWASP A01).
    const resolution = await resolveActiveMachine(rawContext, machines);
    if (!resolution) {
      return {
        ok: false,
        error: {
          success: false,
          error: 'Terminal access is not enabled for this agent. Ask an admin to turn on Terminal Access in this agent\'s settings.',
        },
      };
    }
    if (!resolution.access.allowed) {
      return { ok: false, error: machineAccessDeniedError(resolution.access, resolution.machine) };
    }
    const activeMachine = resolution.machine;
    // Mirror sandbox-tools.ts's driveId/tenantId resolution: an 'existing'
    // machine can reference a Terminal page outside the ambient drive/tenant
    // (global assistant, or a switched active machine in a shared drive).
    // Leaving these ambient would derive a different session key here than
    // bash/writeFile/readFile derive for the SAME active machine.
    const driveId = machines.resolveDriveId
      ? await machines.resolveDriveId(rawContext, activeMachine, ctx.driveId)
      : ctx.driveId;
    const tenantId = machines.resolveTenantId
      ? await machines.resolveTenantId(rawContext, activeMachine, ctx.tenantId)
      : ctx.tenantId;
    return { ok: true, userId: ctx.userId, ctx: { ...ctx, driveId, tenantId, activeMachine } as SandboxActorContext & { activeMachine: MachineRef } };
  };

  /** Direct-exec seam for local git commands (no token needed). */
  const git = (cmd: 'git' | 'gh', args: string[], ctx: SandboxActorContext, cwd?: string) =>
    runGitInSandbox({ cmd, args, cwd, ctx, deps: gitRunDeps });

  /**
   * For remote/gh tools: pre-checks the GitHub token before opening a sandbox.
   * Passes the already-resolved token to `runGitInSandbox` to avoid a second DB fetch.
   */
  const withToken = async (
    options: unknown,
    run: (ctx: SandboxActorContext, token: string) => Promise<unknown>,
  ) => {
    const opened = await open(options);
    if (!opened.ok) return opened.error;
    const token = await gitRunDeps.resolveGitHubToken(opened.userId);
    if (!token) return NO_CONNECTION_ERROR;
    return run(opened.ctx, token);
  };

  /** Remote-exec seam: passes the pre-resolved token to skip the second DB lookup. */
  const gitR = (
    cmd: 'git' | 'gh',
    args: string[],
    ctx: SandboxActorContext,
    token: string,
    cwd?: string,
  ) => runGitInSandbox({ cmd, args, cwd, ctx, deps: gitRunDeps, preResolvedToken: token });

  const seams: GeneratorSeams = { open, git, withToken, gitR };
  return generateSandboxGitTools(SANDBOX_GIT_TOOL_ROWS, seams);
}
