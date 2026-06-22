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
import { drives, pages } from '@pagespace/db/schema/core';
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
} from '@pagespace/lib/services/sandbox/quota';
import { writeCodeExecutionAudit } from '@pagespace/lib/services/sandbox/audit';
import { gateSandboxToolCall } from '@pagespace/lib/services/sandbox/tool-gate';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { loggers } from '@pagespace/lib/logging/logger-config';
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
    },
    buildEnv: defaultBuildEnv,
    audit: (input) => writeCodeExecutionAudit({ input }),
    now: () => new Date(),
    logger: loggers.ai,
  };
}

const VALID_TIERS: ReadonlySet<string> = new Set(['free', 'pro', 'founder', 'business']);

function toTier(value: string | null | undefined): SubscriptionTier {
  return value && VALID_TIERS.has(value) ? (value as SubscriptionTier) : 'free';
}

/**
 * IO dependencies for resolving the sandbox actor context. Injected so the
 * function can be unit-tested without a real database connection.
 */
export interface ResolveSandboxActorContextDeps {
  findDrive: (driveId: string) => Promise<{ ownerId: string } | undefined>;
  findPageDriveId: (pageId: string) => Promise<string | undefined>;
  findUser: (userId: string) => Promise<{ subscriptionTier: string | null } | undefined>;
  getActorInfo: (userId: string) => Promise<{ actorEmail: string; actorDisplayName?: string }>;
}

const defaultResolveDeps: ResolveSandboxActorContextDeps = {
  findDrive: (driveId) =>
    db.query.drives.findFirst({ where: eq(drives.id, driveId), columns: { ownerId: true } }),
  findPageDriveId: async (pageId) => {
    const row = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
      columns: { driveId: true },
    });
    return row?.driveId ?? undefined;
  },
  findUser: (userId) =>
    db.query.users.findFirst({ where: eq(users.id, userId), columns: { subscriptionTier: true } }),
  getActorInfo,
};

/**
 * Factory that creates the actor-context resolver with injected deps. The
 * default export (`resolveSandboxActorContext`) wires the real DB implementations;
 * pass fakes in tests.
 *
 * Discriminates by chatSource.type BEFORE checking driveId — three cases:
 *  - driveId present (page or global): look up drive.ownerId for tenantId.
 *  - page / undefined chatSource, no driveId: fail closed.
 *  - global, no driveId: tenantId = userId (user is their own isolation boundary).
 */
export function createResolveSandboxActorContext(
  deps: ResolveSandboxActorContextDeps = defaultResolveDeps,
): ResolveSandboxContext {
  return async (context) => {
    const userId = context?.userId;
    const conversationId = context?.conversationId;
    if (!userId) return { error: 'Code execution requires an authenticated user.' };
    if (!conversationId) return { error: 'Code execution requires a conversation.' };

    const chatSourceType = context?.chatSource?.type;
    const driveId =
      context?.locationContext?.currentDrive?.id ??
      (
        chatSourceType === 'page' && context?.chatSource?.agentPageId
          ? await deps.findPageDriveId(context.chatSource.agentPageId)
          : undefined
      );

    // Page AI (or undefined chatSource) with no driveId — fail closed. Don't
    // assume global intent when the source type is absent.
    if (chatSourceType !== 'global' && !driveId) {
      return { error: 'Code execution requires an active drive.' };
    }

    // driveId present for both page AI and global AI: resolve tenantId from the
    // drive's owning account. Both surfaces share identical resolution logic here.
    if (driveId) {
      const [drive, actorRow, actorInfo] = await Promise.all([
        deps.findDrive(driveId),
        deps.findUser(userId),
        deps.getActorInfo(userId),
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
      };
    }

    // Global AI without a drive: user is their own isolation boundary.
    // tenantId = userId keeps the session key and quota scopes user-owned.
    // Side-effect: the tenant quota bucket becomes code-exec:tenant:<userId>,
    // a second user-keyed window alongside code-exec:user:<userId>. This
    // over-counts conservatively (only tightens budget) and is acceptable while
    // the feature is admin-gated. Revisit if tenant-scope quota semantics matter.
    const [actorRow, actorInfo] = await Promise.all([
      deps.findUser(userId),
      deps.getActorInfo(userId),
    ]);

    return {
      userId,
      tenantId: userId,
      conversationId,
      requestOrigin: context?.requestOrigin,
      agentPageId: context?.chatSource?.agentPageId ?? context?.parentAgentId,
      actorEmail: actorInfo.actorEmail,
      actorDisplayName: actorInfo.actorDisplayName,
      aiProvider: context?.aiProvider,
      aiModel: context?.aiModel,
      tier: toTier(actorRow?.subscriptionTier),
    };
  };
}

/**
 * Resolve the actor context from the chat tool context. The drive comes from the
 * active location; the tenant is the drive's owning account (the cloud tenant
 * boundary); the concurrency tier is the acting user's subscription tier.
 *
 * Global assistant context (chatSource.type === 'global') is a first-class path:
 * driveId may be absent and resolves with tenantId = userId.
 * Page AI (chatSource.type === 'page' or undefined) requires driveId — fail closed.
 */
export const resolveSandboxActorContext: ResolveSandboxContext =
  createResolveSandboxActorContext();

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
