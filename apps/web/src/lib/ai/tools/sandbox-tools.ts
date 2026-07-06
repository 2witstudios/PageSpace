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

export const MAX_PATH_LENGTH = 1024;

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

export function createSandboxTools({ runDeps, resolveContext, gate }: SandboxToolsDeps): {
  bash: Tool;
  writeFile: Tool;
  readFile: Tool;
  editFile: Tool;
} {
  // Resolve the actor, then run the call-time gate (kill-switch + canRunCode +
  // quota) BEFORE delegating to the runner — a denial returns a safe error and
  // never reaches provisioning. The runner re-enforces every check; this is the
  // defence-in-depth chokepoint at the tool boundary.
  const open = async (
    options: unknown,
  ): Promise<{ ok: true; ctx: SandboxActorContext } | { ok: false; error: { success: false; error: string; retryAfter?: number } }> => {
    const ctx = await resolveContext(readContext(options));
    if ('error' in ctx) return { ok: false, error: { success: false, error: ctx.error } };
    const decision = await gate(ctx);
    if (!decision.ok) return { ok: false, error: gateDenial(decision) };
    return { ok: true, ctx };
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
  };
}
