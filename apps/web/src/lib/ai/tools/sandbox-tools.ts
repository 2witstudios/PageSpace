/**
 * Agent code-execution tools: `bash`, `writeFile`, `readFile`.
 *
 * These are the thin AI SDK `tool()` wrappers over the conversation sandbox.
 * Each `execute` reads the chat context, resolves the actor, and delegates to
 * the corresponding `@pagespace/lib` runner — where the entire safety layer
 * (kill-switch, command/path policy, quota, authz, lifecycle, truncation, audit)
 * lives inline. This file is deliberately small: schema + context resolution +
 * delegation. No execution logic lives here.
 *
 * NOT REGISTERED YET. These are not spread into `pageSpaceTools` and are not
 * discoverable via `tool_search`. Exposure to agents is PR4 (the registration +
 * default-OFF feature flag), the only step that puts execution in front of a
 * model. Until then this module is unreachable from the chat loop.
 *
 * The runner deps and the context resolver are injected so the wrappers are
 * unit-tested with fakes (no DB, no real Vercel API); `buildRealSandboxRunDeps`
 * / `resolveSandboxActorContext` wire the production implementations.
 */

import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { drives } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import {
  runBashInSandbox,
  writeSandboxFile,
  readSandboxFile,
  defaultBuildEnv,
  MAX_WRITE_BYTES,
  type SandboxActorContext,
  type SandboxRunDeps,
} from '@pagespace/lib/services/sandbox/tool-runners';
import { MAX_COMMAND_BYTES } from '@pagespace/lib/services/sandbox/command-policy';
import { isCodeExecutionEnabled, canRunCode } from '@pagespace/lib/services/sandbox/can-run-code';
import {
  acquireConversationSandbox,
  getSandboxSessionSecret,
} from '@pagespace/lib/services/sandbox/session-manager';
import { createVercelSandboxClient } from '@pagespace/lib/services/sandbox/vercel-sandbox-client';
import { createDbSandboxSessionStore } from '@pagespace/lib/services/sandbox/session-store';
import {
  acquireCodeExecutionSlot,
  releaseCodeExecutionSlot,
  checkCodeExecutionQuota,
  chargeCodeExecutionBudget,
} from '@pagespace/lib/services/sandbox/quota';
import { writeCodeExecutionAudit } from '@pagespace/lib/services/sandbox/audit';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
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

// --- Production wiring -------------------------------------------------------

// The session store and sandbox client are process-wide singletons: the store
// reconnects to one DB pool and the client is stateless, so building them once
// avoids reconstruction per tool call. The store import is lazy (DB module
// graph), so it is memoized as a promise.
let storePromise: ReturnType<typeof createDbSandboxSessionStore> | null = null;
const sandboxClient = createVercelSandboxClient();

function getStore() {
  storePromise ??= createDbSandboxSessionStore();
  return storePromise;
}

/** Wire the real lib deps for the runners (DB-backed store + real Vercel client). */
export function buildRealSandboxRunDeps(): SandboxRunDeps {
  return {
    isEnabled: isCodeExecutionEnabled,
    acquireSandbox: async (input) =>
      acquireConversationSandbox({
        ...input,
        deps: {
          store: await getStore(),
          client: sandboxClient,
          authorize: canRunCode,
          now: () => new Date(),
          secret: getSandboxSessionSecret(),
        },
      }),
    reconnect: (sandboxId) => sandboxClient.get({ sandboxId }),
    quota: {
      acquireSlot: acquireCodeExecutionSlot,
      releaseSlot: releaseCodeExecutionSlot,
      preflight: (args) => checkCodeExecutionQuota(args),
      charge: (args) => chargeCodeExecutionBudget(args),
    },
    buildEnv: defaultBuildEnv,
    audit: (input) => writeCodeExecutionAudit({ input }),
    now: () => new Date(),
  };
}

const VALID_TIERS: ReadonlySet<string> = new Set(['free', 'pro', 'founder', 'business']);

function toTier(value: string | null | undefined): SubscriptionTier {
  return value && VALID_TIERS.has(value) ? (value as SubscriptionTier) : 'free';
}

/**
 * Resolve the actor context from the chat tool context. The drive comes from the
 * active location; the tenant is the drive's owning account (the cloud tenant
 * boundary); concurrency tier is the acting user's subscription tier. Any
 * missing required field (user, conversation, drive) is surfaced as an error
 * rather than provisioning against an under-specified scope.
 */
export const resolveSandboxActorContext: ResolveSandboxContext = async (context) => {
  const userId = context?.userId;
  const conversationId = context?.conversationId;
  const driveId = context?.locationContext?.currentDrive?.id;
  if (!userId) return { error: 'Code execution requires an authenticated user.' };
  if (!conversationId) return { error: 'Code execution requires a conversation.' };
  if (!driveId) return { error: 'Code execution requires an active drive.' };

  const [drive, actorRow, actorInfo] = await Promise.all([
    db.query.drives.findFirst({ where: eq(drives.id, driveId), columns: { ownerId: true } }),
    db.query.users.findFirst({ where: eq(users.id, userId), columns: { subscriptionTier: true } }),
    getActorInfo(userId),
  ]);
  if (!drive) return { error: 'Code execution requires an active drive.' };

  return {
    userId,
    tenantId: drive.ownerId,
    driveId,
    conversationId,
    requestOrigin: context?.requestOrigin,
    agentPageId: context?.chatSource?.agentPageId ?? context?.parentAgentId,
    actorEmail: actorInfo.actorEmail,
    actorDisplayName: actorInfo.actorDisplayName,
    aiProvider: context?.aiProvider,
    aiModel: context?.aiModel,
    tier: toTier(actorRow?.subscriptionTier),
    profile: 'default',
  };
};

/**
 * Production sandbox tools, fully wired. Exported for PR4 to register behind the
 * default-OFF feature flag — importing this object does not expose anything by
 * itself.
 */
export function buildSandboxTools(): { bash: Tool; writeFile: Tool; readFile: Tool } {
  return createSandboxTools({
    runDeps: buildRealSandboxRunDeps(),
    resolveContext: resolveSandboxActorContext,
  });
}
