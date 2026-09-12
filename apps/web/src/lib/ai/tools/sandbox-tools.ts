/**
 * Agent code-execution tools: `list_environments`, `bash`, `writeFile`,
 * `readFile`, `editFile`.
 *
 * These are the thin AI SDK `tool()` wrappers over an ADDRESSED sandbox. Every
 * execution tool takes a MANDATORY, OPAQUE `environmentId`, and
 * `list_environments` is the only place one comes from.
 *
 * **This is not the predecessor's free addressing, and it is not the July
 * `target` either.** `switch_machine` / `list_machines` /
 * `resolveActiveMachine`, the MachineRef helpers and the node-target machinery
 * stay deleted: there is no mutable "active machine", no cwd binding, and no
 * way to describe an environment rather than name it. In July an OPTIONAL
 * free-text `target` was added to these same tools and removed two days later
 * (`cf576fbc1`) because the model habitually invented a plausible value
 * (`target: { branch: "main" }`) and every such call was refused. The shape
 * that survives both lessons is: ONE opaque id per call, copied from a
 * discovery list, where a guess simply does not exist and fails closed, and
 * where OMISSION is a schema error rather than a silent fallback to the
 * conversation's own sandbox.
 *
 * The conversation's own sandbox is addressed by the conversation's own id —
 * `ctx.conversationId`, the address the runtime already resolves a session
 * through (contract.ts invariant 1) — and is listed like any other row, so
 * there is no implicit path a model can take while believing it is somewhere
 * else. The injected `acquireSandbox` (sandbox-tools-runtime.ts) resolves that
 * address to a session and lazily ensures its sandbox on the first
 * sandbox-touching call. Every call runs at the sandbox root unless the caller
 * says otherwise.
 *
 * Each `execute` reads the chat context, resolves the actor, runs the
 * call-time gate, and delegates to the corresponding `@pagespace/lib` runner —
 * where the entire safety layer (kill-switch, command/path policy, quota,
 * authz, lifecycle, truncation, audit) lives. This file is deliberately small:
 * schema + context resolution + gate + delegation.
 *
 * This module is the provider-agnostic FACTORY only. It imports no DB and no
 * backing-provider SDK, so it is unit-tested directly with injected fakes. The
 * production wiring lives in `sandbox-tools-runtime.ts`.
 */

import { tool, type Tool } from 'ai';
import { z } from 'zod';
import type { SandboxEnvironmentTarget } from '@pagespace/lib/services/sandbox/tool-runners';
import {
  runBashInSandbox,
  writeSandboxFile,
  readSandboxFile,
  editSandboxFile,
  MAX_WRITE_BYTES,
  type SandboxActorContext,
  type SandboxRunDeps,
} from '@pagespace/lib/services/sandbox/tool-runners';
import { MAX_COMMAND_BYTES } from '@pagespace/lib/services/sandbox/command-policy';
import {
  buildEnvironmentDirectory,
  environmentIdSchema,
  type EnvironmentDirectory,
} from '@pagespace/lib/services/sandbox/environment-directory';
import { DEFAULT_READ_LINES } from '@pagespace/lib/services/sandbox/execution-policy';
import type { SandboxToolGateResult } from '@pagespace/lib/services/sandbox/tool-gate';
import type { ToolExecutionContext } from '../core/types';

export const MAX_PATH_LENGTH = 1024;

/**
 * The MANDATORY address on every code-execution tool (leaf C).
 *
 * Three properties, and each of them is the fix for a different way July's
 * removed `target` went wrong:
 *
 *  - **Mandatory.** `environmentId` is required, so omitting it is a schema
 *    error the model sees and can correct — never a silent fallback to the
 *    conversation's own sandbox. A tool that quietly picks a default when the
 *    address is missing is a tool that runs in the wrong place without saying
 *    so.
 *  - **Opaque.** It is an id copied from `list_environments`, not a name, a
 *    path or a branch. A model cannot invent a cuid2 that happens to exist, so
 *    a guess fails closed.
 *  - **Described.** The `.describe()` below is read by the model and says to
 *    copy rather than construct — July's post-mortem records that the prompt
 *    and the descriptions actively encouraged the bad value, so the wording is
 *    part of the mechanism.
 */
/** Prefixed to every execution tool's description — the instruction the model must read BEFORE it fills the field. */
const COPY_AN_ID =
  'Requires environmentId: an id copied EXACTLY from the output of list_environments, never constructed, guessed or described. Call list_environments first if you do not have one. ';

const environmentIdField = environmentIdSchema.describe(
  'REQUIRED. The id of the environment to run in, copied EXACTLY from the output of list_environments. ' +
    'Never construct, guess, shorten or infer this value, and never pass a name, a path, a branch or a description — ' +
    'an id that did not come from list_environments does not exist and the call will be refused. ' +
    "This conversation's own sandbox has an id in that list like every other environment; there is no default.",
);

export const bashInputSchema = z
  .object({
    environmentId: environmentIdField,
    command: z
      .string()
      .min(1, 'command is required')
      .max(MAX_COMMAND_BYTES, 'command is too large'),
    cwd: z.string().max(MAX_PATH_LENGTH).optional(),
    // Opt-in override for long-running commands (e.g. `bun install`), clamped
    // to SANDBOX_MAX_TIMEOUT_MS by the runner. Omit for the default (120s).
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export const writeFileInputSchema = z
  .object({
    environmentId: environmentIdField,
    path: z.string().min(1, 'path is required').max(MAX_PATH_LENGTH),
    content: z.string().max(MAX_WRITE_BYTES, 'content is too large'),
  })
  .strict();

export const readFileInputSchema = z
  .object({
    environmentId: environmentIdField,
    path: z.string().min(1, 'path is required').max(MAX_PATH_LENGTH),
    // Line-addressed paging. A file longer than the default window is not an
    // error and not a dead end: the result says how many lines exist and which
    // offset returns the next page.
    offset: z
      .number()
      .int()
      .optional()
      .describe('1-based first line to return. Omit to start at the beginning. Zero or negative is clamped to 1.'),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`How many lines to return. Omit for the default ${DEFAULT_READ_LINES}.`),
  })
  .strict();

export const editFileInputSchema = z
  .object({
    environmentId: environmentIdField,
    path: z.string().min(1, 'path is required').max(MAX_PATH_LENGTH),
    oldString: z.string().min(1, 'oldString is required'),
    newString: z.string(),
    replaceAll: z.boolean().optional(),
  })
  .strict();

/** Resolves the actor context for a turn, or an error to surface to the model. */
export type ResolveSandboxContext = (
  context: ToolExecutionContext | undefined,
) => Promise<SandboxActorContext | { error: string }>;

/**
 * The call-time authz/quota gate, bound to the resolved actor context. Denies
 * on the kill-switch, `canRunCode` (app admin + CODE_EXECUTION), and the
 * concurrency preflight — the derived sandbox capability, no stored toggle.
 */
export type SandboxGate = (ctx: SandboxActorContext) => Promise<SandboxToolGateResult>;

/**
 * The persistent environments this actor may reach — already filtered by the
 * store for BOTH conditions (they own the machine, and it is visible to the
 * global assistant). The factory never filters; it only shapes.
 */
export type ListReachableEnvironments = (
  ctx: SandboxActorContext,
) => Promise<readonly { id: string; label: string; substrate: 'sprite' | 'local'; driveId: string }[]>;

/**
 * Resolve the mandatory `environmentId` into the server's own record of WHERE
 * this call goes, or refuse (leaf C).
 *
 * The refusal is ONE sentence for every reason — no such environment, not the
 * caller's, not visible — because telling the caller which of those applies is
 * itself a probe. It names `list_environments`, because a model that has just
 * been refused an id has to be told where a real one comes from.
 */
export type ResolveEnvironmentTarget = (input: {
  ctx: SandboxActorContext;
  environmentId: string;
}) => Promise<{ ok: true; target: SandboxEnvironmentTarget; payer: SandboxPayerCoordinates } | { ok: false; error: string }>;

/**
 * WHO PAYS for this call, resolved from the TARGET rather than from the
 * conversation (leaf D).
 *
 * A named environment is billed and authorized against its own drive, so
 * acting on a drive environment bills that drive's owner exactly as it does
 * when a session is spawned into it from the sidebar — the conversation that
 * happens to be driving it does not change who pays, and must not change who
 * is entitled to run. The gate therefore runs on THESE coordinates, not on the
 * conversation's; resolving them is the runtime's job, because that is where
 * the database is.
 */
export interface SandboxPayerCoordinates {
  /** The payer's drive; absent for a driveless target (a global conversation's own sandbox). */
  readonly driveId?: string;
  readonly ownerId: string;
  readonly tenantId: string;
  readonly tier: SandboxActorContext['tier'];
}

export interface SandboxToolsDeps {
  runDeps: SandboxRunDeps;
  resolveContext: ResolveSandboxContext;
  gate: SandboxGate;
  listEnvironments: ListReachableEnvironments;
  resolveEnvironment: ResolveEnvironmentTarget;
}

function readContext(options: unknown): ToolExecutionContext | undefined {
  return (options as { experimental_context?: ToolExecutionContext })?.experimental_context;
}

// Translate a gate denial into the tool-facing error object (mirrors the
// runners' `{ success: false, error }` shape and carries any retry hint).
function gateDenial(
  denied: Extract<SandboxToolGateResult, { ok: false }>,
): { success: false; error: string; retryAfter?: number } {
  return {
    success: false,
    error: denied.error,
    ...(denied.retryAfter ? { retryAfter: denied.retryAfter } : {}),
  };
}

/**
 * The core sandbox tool names, exported for the per-agent `sandboxEnabled`
 * gate (tool-filtering.ts) — the return type of `createSandboxTools` below is
 * the source of truth, and this list's own test pins the two never drift.
 */
export const SANDBOX_CORE_TOOL_NAMES: readonly string[] = ['list_environments', 'bash', 'writeFile', 'readFile', 'editFile'];

/** The discovery tool's name, so callers name it rather than spelling it. */
export const LIST_ENVIRONMENTS_TOOL_NAME = 'list_environments';

export function createSandboxTools({ runDeps, resolveContext, gate, listEnvironments, resolveEnvironment }: SandboxToolsDeps): {
  list_environments: Tool;
  bash: Tool;
  writeFile: Tool;
  readFile: Tool;
  editFile: Tool;
} {
  // Resolve the actor, then run the call-time gate (kill-switch + canRunCode +
  // quota) BEFORE delegating to the runner — a denial returns a safe error and
  // never reaches provisioning. The runner re-enforces every check; this is the
  // defence-in-depth chokepoint at the tool boundary. The session sandbox needs
  // no resolution step: the ctx's conversationId IS its address, and the
  // injected acquireSandbox does the rest lazily.
  const resolveActor = async (
    options: unknown,
  ): Promise<
    | { ok: true; ctx: SandboxActorContext }
    | { ok: false; error: { success: false; error: string; retryAfter?: number } }
  > => {
    const ctx = await resolveContext(readContext(options));
    if ('error' in ctx) return { ok: false, error: { success: false, error: ctx.error } };
    return { ok: true, ctx };
  };

  const open = async (
    options: unknown,
  ): Promise<
    | { ok: true; ctx: SandboxActorContext }
    | { ok: false; error: { success: false; error: string; retryAfter?: number } }
  > => {
    const actor = await resolveActor(options);
    if (!actor.ok) return actor;
    const decision = await gate(actor.ctx);
    if (!decision.ok) return { ok: false, error: gateDenial(decision) };
    return { ok: true, ctx: actor.ctx };
  };

  // The addressed form: everything `open` does, and then the mandatory
  // `environmentId` resolved into the server's own target. The context handed
  // to a runner ALWAYS carries `ctx.environment`, so no runner can be reached
  // without one — omission is a schema error above this line and a refusal
  // below it, never a default.
  const openAt = async (
    environmentId: string,
    options: unknown,
  ): Promise<
    | { ok: true; ctx: SandboxActorContext }
    | { ok: false; error: { success: false; error: string; retryAfter?: number } }
  > => {
    const actor = await resolveActor(options);
    if (!actor.ok) return actor;
    const resolved = await resolveEnvironment({ ctx: actor.ctx, environmentId });
    if (!resolved.ok) return { ok: false, error: { success: false, error: resolved.error } };
    // The gate runs on the TARGET's payer coordinates, not the conversation's.
    // A free-tier person's dashboard conversation acting in a Pro drive's
    // environment is entitled by that drive's owner — the same rule
    // `canRunCode` and billing already apply — and gating on the conversation
    // would refuse a call the payer has already paid for. It narrows as often
    // as it widens: naming an environment never inherits the conversation's
    // entitlement.
    const ctx: SandboxActorContext = { ...actor.ctx, ...resolved.payer, environment: resolved.target };
    const decision = await gate(ctx);
    if (!decision.ok) return { ok: false, error: gateDenial(decision) };
    return { ok: true, ctx };
  };

  return {
    list_environments: tool({
      description:
        'List the environments you can run in, and the id of each. ' +
        'Call this BEFORE the first bash / writeFile / readFile / editFile call in a conversation, and again if an environment id is refused. ' +
        'Every code-execution tool requires an environmentId, and the ONLY valid source for one is this list: copy an id from the output exactly. ' +
        'Never construct, guess, shorten or infer an environment id, and never reuse one from an earlier conversation — an id that did not come from this list does not exist and the call will be refused. ' +
        'Use the label, not the id, when you talk to the person about where something ran.',
      inputSchema: z.object({}).strict(),
      execute: async (_input, options): Promise<EnvironmentDirectory | { success: false; error: string; retryAfter?: number }> => {
        const opened = await open(options);
        if (!opened.ok) return opened.error;
        const environments = await listEnvironments(opened.ctx);
        // The conversation's own sandbox is addressed by the conversation's own
        // id — the address the runtime already resolves a session through.
        return buildEnvironmentDirectory({
          conversation: { id: opened.ctx.conversationId, driveId: opened.ctx.driveId ?? null },
          environments,
        });
      },
    }),

    bash: tool({
      description:
        COPY_AN_ID +
        'Run a shell command in the named environment. Returns stdout, stderr, the exit code, and the environment it actually ran in. ' +
        "The filesystem is that environment's own and persists across turns.",
      inputSchema: bashInputSchema,
      execute: async ({ environmentId, command, cwd, timeoutMs }, options) => {
        const opened = await openAt(environmentId, options);
        if (!opened.ok) return opened.error;
        return runBashInSandbox({ command, cwd, timeoutMs, ctx: opened.ctx, deps: runDeps });
      },
    }),

    writeFile: tool({
      description:
        COPY_AN_ID +
        'Write a file inside the named environment. A relative path resolves from that environment\'s root and cannot escape it.',
      inputSchema: writeFileInputSchema,
      execute: async ({ environmentId, path, content }, options) => {
        const opened = await openAt(environmentId, options);
        if (!opened.ok) return opened.error;
        return writeSandboxFile({ path, content, ctx: opened.ctx, deps: runDeps });
      },
    }),

    readFile: tool({
      description:
        COPY_AN_ID +
        `Read a file from the named environment. A relative path resolves from that environment's root and cannot escape it. ` +
        `Returns at most ${DEFAULT_READ_LINES} lines per call (override with limit); when a file is longer the result reports totalLines and a notice naming the offset that returns the next page, so page through rather than assuming the file ended. ` +
        `Very long individual lines are shown clipped and marked, so do not build an editFile anchor from a clipped line. ` +
        `Note editFile matches against the whole file, including lines outside the window you read.`,
      inputSchema: readFileInputSchema,
      execute: async ({ environmentId, path, offset, limit }, options) => {
        const opened = await openAt(environmentId, options);
        if (!opened.ok) return opened.error;
        return readSandboxFile({ path, offset, limit, ctx: opened.ctx, deps: runDeps });
      },
    }),

    editFile: tool({
      description:
        COPY_AN_ID +
        'Edit a file in the named environment by replacing oldString with newString. oldString must be unique in the file unless replaceAll is set. Prefer this over writeFile for targeted changes — it does not rewrite the whole file. A relative path resolves from that environment\'s root and cannot escape it.',
      inputSchema: editFileInputSchema,
      execute: async ({ environmentId, path, oldString, newString, replaceAll }, options) => {
        const opened = await openAt(environmentId, options);
        if (!opened.ok) return opened.error;
        return editSandboxFile({ path, oldString, newString, replaceAll, ctx: opened.ctx, deps: runDeps });
      },
    }),
  };
}
