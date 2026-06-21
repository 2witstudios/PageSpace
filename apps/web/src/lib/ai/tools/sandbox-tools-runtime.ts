/**
 * Production wiring for the agent code-execution tools.
 *
 * Binds the provider-agnostic factory (`createSandboxTools`) to the real
 * implementations: the DB-backed session store, the Fly Sprites driver, the
 * quota/concurrency surface, the call-time authz/quota gate, the audit writer,
 * and the chat-context → actor resolver. Kept in its own module so the factory
 * (and its tests) never import the backing-provider SDK (`@fly/sprites` is
 * ESM/node24-only).
 *
 * Importing this module does not expose anything: PR4 calls `buildSandboxTools`
 * and registers the result behind the default-OFF feature flag.
 */

import type { Tool } from 'ai';
import { eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { drives } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { defaultBuildEnv, type SandboxRunDeps } from '@pagespace/lib/services/sandbox/tool-runners';
import { isCodeExecutionEnabled, canRunCode } from '@pagespace/lib/services/sandbox/can-run-code';
import {
  acquireConversationSandbox,
  getSandboxSessionSecret,
} from '@pagespace/lib/services/sandbox/session-manager';
import type { ExecSandboxClient } from '@pagespace/lib/services/sandbox/sandbox-client/types';
import { createDbSandboxSessionStore } from '@pagespace/lib/services/sandbox/session-store';
import {
  acquireCodeExecutionSlot,
  releaseCodeExecutionSlot,
  checkCodeExecutionQuota,
  chargeCodeExecutionBudget,
} from '@pagespace/lib/services/sandbox/quota';
import { writeCodeExecutionAudit } from '@pagespace/lib/services/sandbox/audit';
import { gateSandboxToolCall } from '@pagespace/lib/services/sandbox/tool-gate';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { createSandboxTools, type ResolveSandboxContext } from './sandbox-tools';

// The session store and Sprites client are process-wide singletons: the store
// reconnects to one DB pool and the client is stateless. Both are built lazily
// so importing this module does no DB or SDK work at load.
let storePromise: ReturnType<typeof createDbSandboxSessionStore> | null = null;
let sandboxClientPromise: Promise<ExecSandboxClient> | null = null;

function getStore() {
  storePromise ??= createDbSandboxSessionStore();
  return storePromise;
}

// The Fly Sprites driver is loaded via a DYNAMIC import, never a static one.
// @fly/sprites is ESM-only and @pagespace/lib compiles to CJS, so a static
// import in lib would emit require('@fly/sprites') which Node rejects with
// ERR_REQUIRE_ESM. The factory lives in apps/web/src/lib/sandbox/sprites-client.ts
// instead, where Next.js handles the ESM import correctly. Deferring it here
// also keeps the SDK out of the module graph until code execution is actually
// invoked (only possible once the kill-switch is on).
const MIN_SANDBOX_NODE_MAJOR = 24;

// Deferring the import only protects the OFF path; the ENABLED path still has to
// run on a compatible runtime. Fail CLOSED with an actionable message if a
// Node < 24 process tries to load the SDK, so flipping the flag on a Node 22
// image surfaces the deployment gate ("run the sandbox driver on Node 24+")
// instead of a cryptic ESM/engine failure deep inside the SDK.
function assertSandboxRuntime(): void {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (Number.isNaN(major) || major < MIN_SANDBOX_NODE_MAJOR) {
    throw new Error(
      `Agent code execution requires Node.js >= ${MIN_SANDBOX_NODE_MAJOR} ` +
        `(the @fly/sprites SDK is Node ${MIN_SANDBOX_NODE_MAJOR}+ / ESM-only); ` +
        `this process is Node ${process.versions.node}. Run the sandbox driver on a ` +
        `Node ${MIN_SANDBOX_NODE_MAJOR}+ runtime before enabling code execution.`,
    );
  }
}

function getSandboxClient(): Promise<ExecSandboxClient> {
  sandboxClientPromise ??= (async () => {
    assertSandboxRuntime();
    const { createProductionSpritesSandboxClient } = await import('@/lib/sandbox/sprites-client');
    return createProductionSpritesSandboxClient();
  })().catch((error) => {
    // Never memoize a rejection: a transient lazy-load failure (or a fixable
    // runtime/version misconfiguration) must not poison every later
    // code-execution request in this process until a restart. Clear the cache so
    // the next call retries the import.
    sandboxClientPromise = null;
    throw error;
  });
  return sandboxClientPromise;
}

/** Wire the real lib deps for the runners (DB-backed store + real Sprites driver). */
export function buildRealSandboxRunDeps(): SandboxRunDeps {
  return {
    isEnabled: isCodeExecutionEnabled,
    acquireSandbox: async (input) =>
      acquireConversationSandbox({
        ...input,
        deps: {
          store: await getStore(),
          client: await getSandboxClient(),
          authorize: canRunCode,
          now: () => new Date(),
          secret: getSandboxSessionSecret(),
        },
      }),
    reconnect: async (sandboxId) => (await getSandboxClient()).get({ sandboxId }),
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
 * boundary); the concurrency tier is the acting user's subscription tier. Any
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
    gate: (ctx) =>
      gateSandboxToolCall({
        userId: ctx.userId,
        driveId: ctx.driveId,
        tenantId: ctx.tenantId,
        requestOrigin: ctx.requestOrigin,
        agentPageId: ctx.agentPageId,
        tier: ctx.tier,
      }),
  });
}
