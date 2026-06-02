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

// `@fly/sprites` declares `engines.node >= 24` and uses runtime APIs (global
// WebSocket, …) not guaranteed on the Node 22 web runtime. Until the driver runs
// on a Node >= 24 service (see TODO below) the web process must FAIL CLOSED before
// loading the SDK rather than throw a cryptic ESM/engine error on the first real
// sandbox call.
const REQUIRED_NODE_MAJOR = 24;

// The Fly Sprites driver is loaded via a DYNAMIC import, never a static one:
// `@fly/sprites` is ESM-only and declares `engines.node >= 24`, while the web
// images run Node 22. A static import would pull the SDK into the module graph
// at load — i.e. on every chat request, including the default code-execution-OFF
// path — and evaluate an unsupported SDK. Deferring it here keeps `@fly/sprites`
// out of the graph until a sandbox tool actually runs (only possible once the
// kill-switch is on), so the off-path never touches it.
//
// TODO(agent-code-exec): relocate the Sprites driver to a Node >= 24 runtime
// (the processor or a dedicated sandbox service) and call it over an internal
// API, so the Node 22 web process never loads the SDK at all. Tracked separately;
// until then the guard below keeps the enabled path fail-closed with a clear error.
async function loadSandboxClient(): Promise<ExecSandboxClient> {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (Number.isFinite(nodeMajor) && nodeMajor < REQUIRED_NODE_MAJOR) {
    throw new Error(
      `Agent code execution requires Node >= ${REQUIRED_NODE_MAJOR} to load the @fly/sprites driver, but this ` +
        `runtime is Node ${process.versions.node}. Run the sandbox driver on a Node ${REQUIRED_NODE_MAJOR}+ service ` +
        `before enabling CODE_EXECUTION_ENABLED.`,
    );
  }
  const m = await import('@pagespace/lib/services/sandbox/sandbox-client/sprites');
  return m.createSpritesSandboxClient();
}

function getSandboxClient(): Promise<ExecSandboxClient> {
  // Memoize the live client, but NEVER memoize a rejection: a one-off import or
  // construction failure must not poison every later request until restart, so
  // clear the cache in the failure path and let the next call retry.
  sandboxClientPromise ??= loadSandboxClient().catch((error) => {
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
