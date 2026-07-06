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
import type { ToolExecutionContext } from '../core/types';
import type { MachineRef } from '@/lib/repositories/page-agent-repository';

export const MAX_PATH_LENGTH = 1024;

/** Stable id for a MachineRef, used as the agent-facing handle in list_machines/switch_machine. */
export function machineRefId(machine: MachineRef): string {
  return machine.kind === 'own' ? 'own' : machine.terminalId;
}

export function machineRefEquals(a: MachineRef, b: MachineRef): boolean {
  return machineRefId(a) === machineRefId(b);
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
  })
  .strict();

export const writeFileInputSchema = z
  .object({
    path: z.string().min(1, 'path is required').max(MAX_PATH_LENGTH),
    content: z.string().max(MAX_WRITE_BYTES, 'content is too large'),
  })
  .strict();

export const readFileInputSchema = z
  .object({
    path: z.string().min(1, 'path is required').max(MAX_PATH_LENGTH),
  })
  .strict();

export const editFileInputSchema = z
  .object({
    path: z.string().min(1, 'path is required').max(MAX_PATH_LENGTH),
    oldString: z.string().min(1, 'oldString is required'),
    newString: z.string(),
    replaceAll: z.boolean().optional(),
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
 * Resolves an actor's configured machines and their metadata/accessibility.
 * `PageAgentConfig.terminalAccess`/`machines` (apps/web/src/lib/repositories/
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
  /** Page-permission accessibility check ('existing' checks Terminal page view access; 'own' is always true). */
  isMachineAccessible: (rawContext: ToolExecutionContext | undefined, machine: MachineRef) => Promise<boolean>;
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
}

/**
 * Resolves the ACTIVE machine for a run: the switched machine if one is set
 * and still configured, otherwise the configured default (machines[0]).
 * Terminal tools (bash/file/git) call this to determine which machine's
 * session to operate on — `resolveMachinePageId` (packages/lib/services/
 * sandbox/machine-session.ts) then keys the persistent session by it.
 */
export async function resolveActiveMachine(
  rawContext: ToolExecutionContext | undefined,
  machines: MachineDirectoryDeps,
): Promise<MachineRef> {
  const configured = await machines.listMachines(rawContext);
  const active = rawContext?.activeMachine;
  if (active && configured.some((m) => machineRefEquals(m, active))) return active;
  return configured[0] ?? { kind: 'own' };
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
  ): Promise<
    | { ok: true; ctx: SandboxActorContext & { activeMachine: MachineRef } }
    | { ok: false; error: { success: false; error: string; retryAfter?: number } }
  > => {
    const rawContext = readContext(options);
    const ctx = await resolveContext(rawContext);
    if ('error' in ctx) return { ok: false, error: { success: false, error: ctx.error } };
    const decision = await gate(ctx);
    if (!decision.ok) return { ok: false, error: gateDenial(decision) };
    const activeMachine = await resolveActiveMachine(rawContext, machines);
    // Re-verify page-view access to the resolved machine on EVERY call — not
    // just at switch_machine time. A machine's page permissions (or the
    // Terminal page itself) can change between calls, and this is the actual
    // execution boundary: routing a command to a machine the actor can no
    // longer view would be a silent access-control bypass (OWASP A01).
    const accessible = await machines.isMachineAccessible(rawContext, activeMachine);
    if (!accessible) {
      return {
        ok: false,
        error: {
          success: false,
          error: `You no longer have access to the active machine ("${machineRefId(activeMachine)}"). Call list_machines to see the available options.`,
        },
      };
    }
    const driveId = machines.resolveDriveId
      ? await machines.resolveDriveId(rawContext, activeMachine, ctx.driveId)
      : ctx.driveId;
    return { ok: true, ctx: { ...ctx, driveId, activeMachine } };
  };

  return {
    bash: tool({
      description:
        'Run a shell command in this conversation\'s isolated sandbox. Returns stdout, stderr, and the exit code. The filesystem is scoped to the sandbox.',
      inputSchema: bashInputSchema,
      execute: async ({ command, cwd, timeoutMs }, options) => {
        const opened = await open(options);
        if (!opened.ok) return opened.error;
        return runBashInSandbox({ command, cwd, timeoutMs, ctx: opened.ctx, deps: runDeps });
      },
    }),

    writeFile: tool({
      description:
        'Write a file inside this conversation\'s sandbox. The path is relative to the sandbox root and cannot escape it.',
      inputSchema: writeFileInputSchema,
      execute: async ({ path, content }, options) => {
        const opened = await open(options);
        if (!opened.ok) return opened.error;
        return writeSandboxFile({ path, content, ctx: opened.ctx, deps: runDeps });
      },
    }),

    readFile: tool({
      description:
        'Read a file from this conversation\'s sandbox. The path is relative to the sandbox root and cannot escape it.',
      inputSchema: readFileInputSchema,
      execute: async ({ path }, options) => {
        const opened = await open(options);
        if (!opened.ok) return opened.error;
        return readSandboxFile({ path, ctx: opened.ctx, deps: runDeps });
      },
    }),

    editFile: tool({
      description:
        'Edit a file in this conversation\'s sandbox by replacing oldString with newString. oldString must be unique in the file unless replaceAll is set. Prefer this over writeFile for targeted changes — it does not rewrite the whole file. The path is relative to the sandbox root and cannot escape it.',
      inputSchema: editFileInputSchema,
      execute: async ({ path, oldString, newString, replaceAll }, options) => {
        const opened = await open(options);
        if (!opened.ok) return opened.error;
        return editSandboxFile({ path, oldString, newString, replaceAll, ctx: opened.ctx, deps: runDeps });
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

        const accessible = await machines.isMachineAccessible(rawContext, target);
        if (!accessible) {
          return {
            success: false,
            error: `You no longer have access to "${requestedId}".`,
            reason: 'inaccessible' as const,
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
        const active = await resolveActiveMachine(rawContext, machines);
        // Mirror list_pages: only surface machines the actor can currently
        // access — a machine's page permissions can be revoked after it was
        // configured, and describeMachine's title lookup does not itself
        // check accessibility.
        const accessibleEntries = await Promise.all(
          configured.map(async (m) => ({ machine: m, accessible: await machines.isMachineAccessible(rawContext, m) })),
        );
        const entries = await Promise.all(
          accessibleEntries
            .filter(({ accessible }) => accessible)
            .map(async ({ machine: m }) => {
              const desc = await machines.describeMachine(rawContext, m);
              return {
                id: machineRefId(m),
                name: desc.name,
                ...(desc.description ? { description: desc.description } : {}),
                active: machineRefEquals(m, active),
              };
            }),
        );
        return { success: true, machines: entries };
      },
    }),
  };
}
