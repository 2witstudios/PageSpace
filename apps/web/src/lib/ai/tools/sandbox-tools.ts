/**
 * Agent code-execution tools: `bash`, `writeFile`, `readFile`.
 *
 * These are the thin AI SDK `tool()` wrappers over the conversation sandbox.
 * Each `execute` reads the chat context, resolves the actor, runs the call-time
 * gate, and delegates to the corresponding `@pagespace/lib` runner — where the
 * entire safety layer (kill-switch, command/path policy, quota, authz,
 * lifecycle, truncation, audit) lives inline. This file is deliberately small:
 * schema + context resolution + gate + delegation. No execution logic lives
 * here.
 *
 * This module is the provider-agnostic FACTORY only. It imports no DB and no
 * backing-provider SDK, so it is unit-tested directly with injected fakes. The
 * production wiring — the DB-backed session store, the Fly Sprites driver, the
 * quota/audit surface, and the actor resolver — lives in
 * `sandbox-tools-runtime.ts`, which builds the `Tool` objects PR4 registers
 * behind the default-OFF feature flag.
 */

import { tool, type Tool } from 'ai';
import { z } from 'zod';
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
import type { SandboxToolGateResult } from '@pagespace/lib/services/sandbox/tool-gate';
import type { MachineToggleDenialCode } from '@pagespace/lib/services/machines/machine-access';
import {
  resolveMachineNodeTarget,
  type MachineNodeHandle,
  type MachineNodeTarget,
} from '@pagespace/lib/services/machines/machine-pane-binding';
import type { ToolExecutionContext } from '../core/types';
import type { MachineRef } from '@/lib/repositories/page-agent-repository';

export const MAX_PATH_LENGTH = 1024;

/** Stable id for a MachineRef, used as the agent-facing handle in list_machines/switch_machine. */
export function machineRefId(machine: MachineRef): string {
  return machine.kind === 'own' ? 'own' : machine.machineId;
}

export function machineRefEquals(a: MachineRef, b: MachineRef): boolean {
  return machineRefId(a) === machineRefId(b);
}

/**
 * `bash`'s cwd-default policy for a machine-bound "PageSpace Agent" pane
 * (issue #2166 phase 7): an explicit `cwd` argument always wins; absent one,
 * the RESOLVED NODE's `cwd` (the pane's own checkout, or the checkout of the
 * node its `target` addressed) is used. Returns `undefined` when neither is
 * present, preserving the runner's own SANDBOX_ROOT default.
 */
export function bindingCwdFor(
  explicitCwd: string | undefined,
  binding: { cwd: string } | undefined,
): string | undefined {
  return explicitCwd ?? binding?.cwd;
}

/**
 * The FILE tools' counterpart to {@link bindingCwdFor}.
 *
 * `writeFile`/`readFile`/`editFile` take a path, not a cwd, and the runner
 * resolves it against SANDBOX_ROOT (`resolveSandboxPath`). Without this, a
 * relative path is rooted at `/workspace` no matter which node the call
 * resolved to — so `target: { project: 'foo' }` would read and write
 * `/workspace/a.txt` while `bash` in the same target ran in
 * `/workspace/projects/foo`. Two tools, one addressed node, different files.
 *
 * Relative paths are therefore anchored to the RESOLVED NODE's cwd, which is
 * exactly the default `bash` already applies. An ABSOLUTE path is left alone —
 * it is the file-tool analogue of `bash`'s explicit `cwd` argument, and the
 * runner still confines it to the sandbox root, so this can widen no reach.
 */
export function nodeScopedPath(path: string, node: { cwd: string } | undefined): string {
  const cwd = node?.cwd;
  if (!cwd || path.startsWith('/')) return path;
  return `${cwd.replace(/\/+$/, '')}/${path}`;
}

/**
 * Direct child addressing (node epic): every code-execution tool may aim at a
 * node BENEATH the conversation's own — a project, or a branch — instead of
 * the node it is bound to. Resolution runs against the derived handle set
 * (`resolveMachineNodeTarget`), so a node outside the set is simply not
 * addressable. `branch` alone is enough when the conversation already lives in
 * a project, or when the name is unique across the whole set.
 */
export const nodeTargetSchema = z
  .object({
    project: z.string().min(1).max(MAX_PATH_LENGTH).optional(),
    branch: z.string().min(1).max(MAX_PATH_LENGTH).optional(),
  })
  .strict();

/** The tool-facing denial for a `target` that the conversation's node scope doesn't contain. */
export function nodeTargetDeniedError(
  reason: 'target_not_in_set' | 'ambiguous_target' | 'unbound',
  target: MachineNodeTarget,
): { success: false; error: string } {
  const described = [
    target.project ? `project "${target.project}"` : undefined,
    target.branch ? `branch "${target.branch}"` : undefined,
  ]
    .filter(Boolean)
    .join(' / ');
  if (reason === 'ambiguous_target') {
    return {
      success: false,
      error: `The target ${described} is ambiguous — that branch name exists under more than one project. Name the project as well.`,
    };
  }
  if (reason === 'unbound') {
    return {
      success: false,
      error: `This conversation is not bound to a machine, so it has no node scope to address — remove the target (${described}).`,
    };
  }
  return {
    success: false,
    error: `The target ${described} is not part of this conversation's machine scope. Call list_sessions to see the nodes you can address.`,
  };
}

/** Resolves an agent-facing id (from switch_machine's input) back to a configured MachineRef. */
export function machineRefFromId(id: string, configured: MachineRef[]): MachineRef | undefined {
  return configured.find((m) => machineRefId(m) === id);
}

export const bashInputSchema = z
  .object({
    command: z
      .string()
      .min(1, 'command is required')
      .max(MAX_COMMAND_BYTES, 'command is too large'),
    cwd: z.string().max(MAX_PATH_LENGTH).optional(),
    // Opt-in override for long-running commands (e.g. `bun install`), clamped
    // to SANDBOX_MAX_TIMEOUT_MS by the runner. Omit for the default (120s).
    timeoutMs: z.number().int().positive().optional(),
    target: nodeTargetSchema.optional(),
  })
  .strict();

export const writeFileInputSchema = z
  .object({
    path: z.string().min(1, 'path is required').max(MAX_PATH_LENGTH),
    content: z.string().max(MAX_WRITE_BYTES, 'content is too large'),
    target: nodeTargetSchema.optional(),
  })
  .strict();

export const readFileInputSchema = z
  .object({
    path: z.string().min(1, 'path is required').max(MAX_PATH_LENGTH),
    target: nodeTargetSchema.optional(),
  })
  .strict();

export const editFileInputSchema = z
  .object({
    path: z.string().min(1, 'path is required').max(MAX_PATH_LENGTH),
    oldString: z.string().min(1, 'oldString is required'),
    newString: z.string(),
    replaceAll: z.boolean().optional(),
    target: nodeTargetSchema.optional(),
  })
  .strict();

export const switchMachineInputSchema = z
  .object({
    machine: z.string().min(1, 'machine is required'),
  })
  .strict();

export const listMachinesInputSchema = z.object({}).strict();

/** Human-facing name + optional description for a configured machine. */
export interface MachineDescriptor {
  name: string;
  description?: string;
}

/**
 * Outcome of a machine access check. A denial MAY carry a machine-readable
 * `code` (the Machine Settings toggle that blocked access — see
 * `decideMachineToggleAccess` in @pagespace/lib machines/machine-access) and
 * an LLM-facing `reason` explaining it; without them, callers fall back to
 * their generic revoked-access message.
 */
export type MachineAccessDecision =
  | { allowed: true }
  | { allowed: false; code?: MachineToggleDenialCode; reason?: string };

/**
 * Resolves an actor's configured machines and their metadata/accessibility.
 * `PageAgentConfig.machineAccess`/`machines` (apps/web/src/lib/repositories/
 * page-agent-repository.ts) is the canonical config source; production wires
 * `listMachines` to it (`createMachineDirectory` in sandbox-tools-runtime.ts).
 */
export interface MachineDirectoryDeps {
  /** List this actor's configured machines; machines[0] is the default active machine. */
  listMachines: (rawContext: ToolExecutionContext | undefined) => Promise<MachineRef[]>;
  /** Human-facing name + optional description for a configured machine. */
  describeMachine: (
    rawContext: ToolExecutionContext | undefined,
    machine: MachineRef,
  ) => Promise<MachineDescriptor>;
  /**
   * Machine access check ('own' is always allowed). For 'existing' machines this
   * covers Terminal page view access AND the Machine's own access toggles
   * (`allowPageAgents` for page-scoped agents, `visibleToGlobalAssistant` for
   * the global assistant); a toggle denial carries an explanatory `reason`.
   */
  isMachineAccessible: (
    rawContext: ToolExecutionContext | undefined,
    machine: MachineRef,
  ) => Promise<MachineAccessDecision>;
  /**
   * Resolve the drive that actually backs a machine, overriding the ambient
   * `ctx.driveId` (from chat location context) when it differs. Needed for
   * the global assistant: its ambient driveId (if any) reflects wherever the
   * user happens to be chatting FROM, which may not be the drive containing
   * the active machine's Terminal page. Optional — omitted implementations
   * (existing page-agent wiring) keep using the ambient driveId unchanged,
   * which is always correct there since a page agent's 'existing' machines
   * are constrained to its own drive.
   */
  resolveDriveId?: (
    rawContext: ToolExecutionContext | undefined,
    machine: MachineRef,
    ambientDriveId: string | undefined,
  ) => Promise<string | undefined>;
  /**
   * Resolve the tenant (drive owner) that actually backs a machine, overriding
   * the ambient `ctx.tenantId` the same way `resolveDriveId` overrides
   * `ctx.driveId` — and for the same reason: an 'existing' machine can
   * reference a Terminal page in a drive the acting context doesn't already
   * reflect (global assistant, or a page agent's active machine switched to a
   * shared drive's Terminal). Session-key derivation
   * (`packages/lib/src/services/sandbox/machine-session-manager.ts`) keys off
   * `tenantId` + `driveId` + `pageId`; the realtime PTY path
   * (`apps/realtime/src/index.ts`'s `buildMachineSandbox`) always resolves
   * tenantId fresh from the machine's own page, so leaving this ambient would
   * derive a DIFFERENT session key than the realtime path for the same
   * page — an agent's tool calls would silently attach to a different Sprite
   * than the one a human's live Terminal view is connected to. Optional —
   * omitted implementations keep using the ambient tenantId unchanged.
   */
  resolveTenantId?: (
    rawContext: ToolExecutionContext | undefined,
    machine: MachineRef,
    ambientTenantId: string,
  ) => Promise<string>;
}

/** The active machine for a run, paired with its (already-performed) access check. */
export interface ActiveMachineResolution {
  machine: MachineRef;
  access: MachineAccessDecision;
}

/**
 * Resolves the ACTIVE machine for a run: the switched machine if one is set
 * and still configured, otherwise the first configured machine the actor can
 * actually ACCESS (falling back past machines a Settings toggle or revoked
 * page permission blocks, so a blocked machines[0] doesn't dead-end the whole
 * tool group while a usable machine sits one slot over). Terminal tools
 * (bash/file/git) call this to determine which machine's session to operate
 * on — `resolveMachinePageId` (packages/lib/services/sandbox/
 * machine-session.ts) then keys the persistent session by it.
 *
 * The access check happens HERE, on every call, and is returned alongside the
 * machine so callers enforce it without a second lookup:
 * - An explicitly switched machine is honored even when access has since been
 *   revoked — the caller denies it with the specific reason rather than
 *   silently rerouting the agent's commands to a different machine.
 * - When NO configured machine is accessible, the first one is returned with
 *   its denial so the caller surfaces the actual cause (e.g. a toggle reason)
 *   instead of pretending nothing is configured.
 *
 * Returns `undefined` only when the actor has no configured machines at all —
 * `listMachines` (createMachineDirectory) returns `[]` exactly when
 * `machineAccess` is off, so an empty list here is never "no preference,
 * default to 'own'"; it is "not entitled." Callers MUST treat `undefined` as
 * a denial, not silently fall back to `{ kind: 'own' }` — that fallback used
 * to key an implicit persistent machine off the agent's own page even with
 * machineAccess off, defeating the gate (OWASP A01).
 */
export async function resolveActiveMachine(
  rawContext: ToolExecutionContext | undefined,
  machines: MachineDirectoryDeps,
): Promise<ActiveMachineResolution | undefined> {
  const configured = await machines.listMachines(rawContext);
  if (configured.length === 0) return undefined;
  const active = rawContext?.activeMachine;
  if (active && configured.some((m) => machineRefEquals(m, active))) {
    return { machine: active, access: await machines.isMachineAccessible(rawContext, active) };
  }
  let firstDenied: ActiveMachineResolution | undefined;
  for (const machine of configured) {
    const access = await machines.isMachineAccessible(rawContext, machine);
    if (access.allowed) return { machine, access };
    firstDenied ??= { machine, access };
  }
  return firstDenied;
}

/**
 * Selects the active machine from an ALREADY-COMPUTED decision set. Mirrors
 * `resolveActiveMachine`'s selection policy (an explicitly switched machine
 * wins even if it's since become inaccessible; otherwise the first ACCESSIBLE
 * configured machine; otherwise, when every machine is denied, the first
 * configured machine) without re-invoking `isMachineAccessible` — for
 * `list_machines`, which already computes a decision for every configured
 * machine to build its accessible-only display list, calling
 * `resolveActiveMachine` separately would re-fetch the machine list and
 * re-check accessibility, doubling the `isMachineAccessible` calls.
 */
function selectActiveFromDecisions(
  configured: MachineRef[],
  decisions: MachineAccessDecision[],
  switched: MachineRef | undefined,
): MachineRef | undefined {
  if (configured.length === 0) return undefined;
  if (switched && configured.some((m) => machineRefEquals(m, switched))) return switched;
  const firstAllowedIndex = decisions.findIndex((d) => d.allowed);
  return firstAllowedIndex !== -1 ? configured[firstAllowedIndex] : configured[0];
}

/**
 * Renders a machine access denial as the tool-facing error object, preferring
 * the decision's specific LLM-facing reason (e.g. which Settings toggle blocked
 * it) over the generic revoked-access message. Shared by the bash/file tools
 * here and the git tools (sandbox-git-tools.ts) so both execution boundaries
 * report identical denials for the same machine.
 */
export function machineAccessDeniedError(
  access: Extract<MachineAccessDecision, { allowed: false }>,
  machine: MachineRef,
): { success: false; error: string } {
  return {
    success: false,
    error:
      access.reason ??
      `You no longer have access to the active machine ("${machineRefId(machine)}"). Call list_machines to see the available options.`,
  };
}

/** Resolves the actor context for a turn, or an error to surface to the model. */
export type ResolveSandboxContext = (
  context: ToolExecutionContext | undefined,
) => Promise<SandboxActorContext | { error: string }>;

/** The call-time authz/quota gate, bound to the resolved actor context. */
export type SandboxGate = (ctx: SandboxActorContext) => Promise<SandboxToolGateResult>;

export interface SandboxToolsDeps {
  runDeps: SandboxRunDeps;
  resolveContext: ResolveSandboxContext;
  gate: SandboxGate;
  machines: MachineDirectoryDeps;
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

export function createSandboxTools({ runDeps, resolveContext, gate, machines }: SandboxToolsDeps): {
  bash: Tool;
  writeFile: Tool;
  readFile: Tool;
  editFile: Tool;
  switch_machine: Tool;
  list_machines: Tool;
} {
  // Resolve the actor, then run the call-time gate (kill-switch + canRunCode +
  // quota) BEFORE delegating to the runner — a denial returns a safe error and
  // never reaches provisioning. The runner re-enforces every check; this is the
  // defence-in-depth chokepoint at the tool boundary. Also resolves the ACTIVE
  // machine and threads it onto the ctx handed to the runner, which routes the
  // session acquisition to that machine's persistent Sprite (machine-session.ts).
  const open = async (
    options: unknown,
    target?: MachineNodeTarget,
  ): Promise<
    | { ok: true; ctx: SandboxActorContext & { activeMachine: MachineRef }; node?: MachineNodeHandle }
    | { ok: false; error: { success: false; error: string; retryAfter?: number } }
  > => {
    const rawContext = readContext(options);
    const ctx = await resolveContext(rawContext);
    if ('error' in ctx) return { ok: false, error: { success: false, error: ctx.error } };
    const decision = await gate(ctx);
    if (!decision.ok) return { ok: false, error: gateDenial(decision) };
    // resolveActiveMachine re-verifies access to the resolved machine on
    // EVERY call — not just at switch_machine time. A machine's page
    // permissions or Settings toggles can change between calls, and this is
    // the actual execution boundary: routing a command to a machine the actor
    // can no longer use would be a silent access-control bypass (OWASP A01).
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
    const driveId = machines.resolveDriveId
      ? await machines.resolveDriveId(rawContext, activeMachine, ctx.driveId)
      : ctx.driveId;
    const tenantId = machines.resolveTenantId
      ? await machines.resolveTenantId(rawContext, activeMachine, ctx.tenantId)
      : ctx.tenantId;
    // Which NODE this call runs at: the conversation's own by default, or the
    // one its `target` addresses. Resolution is pure set membership
    // (resolveMachineNodeTarget) — an unaddressable node is one the derived
    // set never contained, which is the same fact `isMachineAccessible`
    // enforces for the machine itself. No second policy lives here.
    const binding = rawContext?.machineBinding;
    if (!binding) {
      // A target without a node scope to resolve it in is a mistake, not a
      // silent no-op: answering it at the machine root would run the call
      // somewhere the model didn't ask for.
      if (target && (target.project || target.branch)) {
        return { ok: false, error: nodeTargetDeniedError('unbound', target) };
      }
      return { ok: true, ctx: { ...ctx, driveId, tenantId, activeMachine, branchSandbox: undefined, projectSandbox: undefined } };
    }
    const resolved = resolveMachineNodeTarget(binding, target);
    if (!resolved.ok) return { ok: false, error: nodeTargetDeniedError(resolved.reason, target ?? {}) };
    const node = resolved.handle;
    // A node with its own Sprite — a branch, or a PROMOTED project (issue
    // #2204 phase 7) — routes acquireSandbox through that tier's attach-only
    // seam (acquireRequest in tool-runners.ts forwards both keys); an
    // unpromoted project carries neither and still runs on the machine's own
    // Sprite at the checkout's cwd. This is the one place the resolved node is
    // translated onto the actor ctx. `machineId` comes off the handle, so the
    // payer/guardrail key stays the owning machine page however deep the
    // target reaches.
    const branchSandbox = node.branchSandbox
      ? { machineId: node.machineId, machineBranchId: node.branchSandbox.machineBranchId }
      : undefined;
    const projectSandbox = node.projectSandbox
      ? { machineId: node.machineId, machineProjectId: node.projectSandbox.machineProjectId }
      : undefined;
    return { ok: true, ctx: { ...ctx, driveId, tenantId, activeMachine, branchSandbox, projectSandbox }, node };
  };

  return {
    bash: tool({
      description:
        'Run a shell command in this conversation\'s isolated sandbox. Returns stdout, stderr, and the exit code. The filesystem is scoped to the sandbox. In a machine-bound conversation you may add target: { project?, branch? } to run against a project or branch beneath your node instead of your own; omit it to use your own node.',
      inputSchema: bashInputSchema,
      execute: async ({ command, cwd, timeoutMs, target }, options) => {
        const opened = await open(options, target);
        if (!opened.ok) return opened.error;
        return runBashInSandbox({
          command,
          cwd: bindingCwdFor(cwd, opened.node),
          timeoutMs,
          ctx: opened.ctx,
          deps: runDeps,
        });
      },
    }),

    writeFile: tool({
      description:
        'Write a file inside this conversation\'s sandbox. A relative path resolves from your node\'s working directory, and cannot escape the sandbox root. In a machine-bound conversation you may add target: { project?, branch? } to act on a project or branch beneath your node instead of your own — a relative path then resolves from THAT node\'s working directory; omit it to use your own node. Pass an absolute path to override this.',
      inputSchema: writeFileInputSchema,
      execute: async ({ path, content, target }, options) => {
        const opened = await open(options, target);
        if (!opened.ok) return opened.error;
        return writeSandboxFile({ path: nodeScopedPath(path, opened.node), content, ctx: opened.ctx, deps: runDeps });
      },
    }),

    readFile: tool({
      description:
        'Read a file from this conversation\'s sandbox. A relative path resolves from your node\'s working directory, and cannot escape the sandbox root. In a machine-bound conversation you may add target: { project?, branch? } to act on a project or branch beneath your node instead of your own — a relative path then resolves from THAT node\'s working directory; omit it to use your own node. Pass an absolute path to override this.',
      inputSchema: readFileInputSchema,
      execute: async ({ path, target }, options) => {
        const opened = await open(options, target);
        if (!opened.ok) return opened.error;
        return readSandboxFile({ path: nodeScopedPath(path, opened.node), ctx: opened.ctx, deps: runDeps });
      },
    }),

    editFile: tool({
      description:
        'Edit a file in this conversation\'s sandbox by replacing oldString with newString. oldString must be unique in the file unless replaceAll is set. Prefer this over writeFile for targeted changes — it does not rewrite the whole file. A relative path resolves from your node\'s working directory, and cannot escape the sandbox root. In a machine-bound conversation you may add target: { project?, branch? } to act on a project or branch beneath your node instead of your own — a relative path then resolves from THAT node\'s working directory; omit it to use your own node. Pass an absolute path to override this.',
      inputSchema: editFileInputSchema,
      execute: async ({ path, oldString, newString, replaceAll, target }, options) => {
        const opened = await open(options, target);
        if (!opened.ok) return opened.error;
        return editSandboxFile({
          path: nodeScopedPath(path, opened.node),
          oldString,
          newString,
          replaceAll,
          ctx: opened.ctx,
          deps: runDeps,
        });
      },
    }),

    switch_machine: tool({
      description:
        'Set your ACTIVE machine to one of your configured machines (see list_machines for the available ids). ' +
        'Terminal tools (bash/readFile/writeFile/editFile/git) operate on the active machine\'s session — switching ' +
        'takes effect immediately for subsequent calls in this conversation. A cold machine wakes transparently; ' +
        'you never need to check whether it is running.',
      inputSchema: switchMachineInputSchema,
      execute: async ({ machine: requestedId }, options) => {
        const rawContext = readContext(options);
        const ctx = await resolveContext(rawContext);
        if ('error' in ctx) return { success: false, error: ctx.error };

        const configured = await machines.listMachines(rawContext);
        const target = machineRefFromId(requestedId, configured);
        if (!target) {
          return {
            success: false,
            error: `"${requestedId}" is not one of your configured machines. Call list_machines to see the available options.`,
            reason: 'unconfigured' as const,
          };
        }

        const access = await machines.isMachineAccessible(rawContext, target);
        if (!access.allowed) {
          // A toggle denial carries its own code so callers can distinguish
          // "reconfigure the machine's Settings toggles" from revoked access.
          return {
            success: false,
            error: access.reason ?? `You no longer have access to "${requestedId}".`,
            reason: access.code ?? ('inaccessible' as const),
          };
        }

        if (!rawContext) {
          return {
            success: false,
            error: 'Unable to switch machines without an execution context.',
          };
        }

        // Mutate the shared per-run context object in place so later tool
        // calls in this same turn see the new active machine (see the
        // activeMachine doc comment on ToolExecutionContext).
        rawContext.activeMachine = target;

        const desc = await machines.describeMachine(rawContext, target);
        return { success: true, active: machineRefId(target), name: desc.name };
      },
    }),

    list_machines: tool({
      description:
        'List your configured machines and which one is currently ACTIVE. Does not report whether a machine is ' +
        'running, hibernated, or installing — waking is transparent. Use switch_machine to change the active machine.',
      inputSchema: listMachinesInputSchema,
      execute: async (_input, options) => {
        const rawContext = readContext(options);
        const ctx = await resolveContext(rawContext);
        if ('error' in ctx) return { success: false, error: ctx.error };

        const configured = await machines.listMachines(rawContext);
        // ONE isMachineAccessible pass, reused for both active-machine
        // selection (selectActiveFromDecisions, no I/O) and the accessible-only
        // filter below — mirrors list_pages: only surface machines the actor
        // can currently access, since a machine's page permissions can be
        // revoked after it was configured and describeMachine's title lookup
        // does not itself check accessibility. (When every machine is denied,
        // `active` is the first configured machine, which is filtered out
        // below with the rest — the model correctly sees an empty list.)
        const decisions = await Promise.all(configured.map((m) => machines.isMachineAccessible(rawContext, m)));
        const active = selectActiveFromDecisions(configured, decisions, rawContext?.activeMachine);
        const entries = await Promise.all(
          configured
            .map((m, i) => ({ machine: m, accessible: decisions[i].allowed }))
            .filter(({ accessible }) => accessible)
            .map(async ({ machine: m }) => {
              const desc = await machines.describeMachine(rawContext, m);
              return {
                id: machineRefId(m),
                name: desc.name,
                ...(desc.description ? { description: desc.description } : {}),
                active: active !== undefined && machineRefEquals(m, active),
              };
            }),
        );
        return { success: true, machines: entries };
      },
    }),
  };
}
