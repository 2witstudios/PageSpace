/**
 * Agent code-execution tools: `bash`, `writeFile`, `readFile` (factory + schemas).
 *
 * Thin AI SDK `tool()` wrappers over the conversation sandbox. Each `execute`
 * reads the chat context, resolves the actor, and delegates to the
 * `@pagespace/lib` runner — where the entire safety layer (kill-switch,
 * command/path policy, quota, authz, lifecycle, truncation, audit) lives inline.
 * This file is deliberately provider-agnostic: schema + context resolution +
 * delegation, with the runner deps and context resolver INJECTED. No execution
 * logic and no backing-provider SDK are imported here, so it is unit-tested with
 * fakes. The production wiring (DB + the Fly Sprites driver) lives in
 * `sandbox-tools-runtime.ts`.
 *
 * NOT REGISTERED YET. These are not spread into `pageSpaceTools` and are not
 * discoverable via `tool_search`. Exposure to agents is PR4 (registration +
 * default-OFF feature flag). Until then this module is unreachable from chat.
 */

import { tool, type Tool } from 'ai';
import { z } from 'zod';
import {
  runBashInSandbox,
  writeSandboxFile,
  readSandboxFile,
  MAX_WRITE_BYTES,
  type SandboxActorContext,
  type SandboxRunDeps,
} from '@pagespace/lib/services/sandbox/tool-runners';
import { MAX_COMMAND_BYTES } from '@pagespace/lib/services/sandbox/command-policy';
import { type ToolExecutionContext } from '../core';

const MAX_PATH_LENGTH = 1024;

export const bashInputSchema = z.object({
  command: z
    .string()
    .min(1, 'command is required')
    .max(MAX_COMMAND_BYTES, 'command is too large'),
  cwd: z.string().max(MAX_PATH_LENGTH).optional(),
});

export const writeFileInputSchema = z.object({
  path: z.string().min(1, 'path is required').max(MAX_PATH_LENGTH),
  content: z.string().max(MAX_WRITE_BYTES, 'content is too large'),
});

export const readFileInputSchema = z.object({
  path: z.string().min(1, 'path is required').max(MAX_PATH_LENGTH),
});

/** Resolves the actor context for a turn, or an error to surface to the model. */
export type ResolveSandboxContext = (
  context: ToolExecutionContext | undefined,
) => Promise<SandboxActorContext | { error: string }>;

export interface SandboxToolsDeps {
  runDeps: SandboxRunDeps;
  resolveContext: ResolveSandboxContext;
}

function readContext(options: unknown): ToolExecutionContext | undefined {
  return (options as { experimental_context?: ToolExecutionContext })?.experimental_context;
}

export function createSandboxTools({ runDeps, resolveContext }: SandboxToolsDeps): {
  bash: Tool;
  writeFile: Tool;
  readFile: Tool;
} {
  return {
    bash: tool({
      description:
        'Run a shell command in this conversation\'s isolated sandbox. Returns stdout, stderr, and the exit code. No network access; the filesystem is ephemeral and scoped to the sandbox.',
      inputSchema: bashInputSchema,
      execute: async ({ command, cwd }, options) => {
        const ctx = await resolveContext(readContext(options));
        if ('error' in ctx) return { success: false, error: ctx.error };
        return runBashInSandbox({ command, cwd, ctx, deps: runDeps });
      },
    }),

    writeFile: tool({
      description:
        'Write a file inside this conversation\'s sandbox. The path is relative to the sandbox root and cannot escape it.',
      inputSchema: writeFileInputSchema,
      execute: async ({ path, content }, options) => {
        const ctx = await resolveContext(readContext(options));
        if ('error' in ctx) return { success: false, error: ctx.error };
        return writeSandboxFile({ path, content, ctx, deps: runDeps });
      },
    }),

    readFile: tool({
      description:
        'Read a file from this conversation\'s sandbox. The path is relative to the sandbox root and cannot escape it.',
      inputSchema: readFileInputSchema,
      execute: async ({ path }, options) => {
        const ctx = await resolveContext(readContext(options));
        if ('error' in ctx) return { success: false, error: ctx.error };
        return readSandboxFile({ path, ctx, deps: runDeps });
      },
    }),
  };
}
