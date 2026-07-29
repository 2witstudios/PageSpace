/**
 * Production wiring for the agent code-execution tools.
 *
 * Binds the provider-agnostic factory (`createSandboxTools`) to the real
 * implementations: the session-anchored sandbox acquisition, the Fly Sprites
 * driver, the quota/concurrency surface, the call-time authz/quota gate, the
 * audit writer, and the chat-context → actor resolver. Kept in its own module
 * so the factory (and its tests) never import the backing-provider SDK
 * (`@fly/sprites` is ESM/node24-only).
 *
 * THE HANDLE SOURCE: `acquireSandbox` lazily ensures the conversation's agent
 * session row and its Sprite from `conversationId` alone — the session id IS
 * the conversation id (contract.ts invariant 1), and this is one of the two
 * sanctioned first-touch provisioning sites (the other is a shell open). It
 * runs through the SAME `ensureSession`/`provisionSessionSandbox` path the API
 * routes and the realtime bridge use, so the CAS in `agent-session-sprite.ts`
 * actually serializes every concurrent provisioner.
 */

import type { Tool } from 'ai';
import { eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { drives, pages } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { defaultBuildEnv, type SandboxRunDeps } from '@pagespace/lib/services/sandbox/tool-runners';
import { isCodeExecutionEnabled } from '@pagespace/lib/services/sandbox/can-run-code';
import {
  screenToolOutput,
  heuristicInjectionClassifier,
} from '@pagespace/lib/services/sandbox/injection-seam';
import { defaultSandboxBillingDeps } from '@pagespace/lib/services/sandbox/sandbox-billing';
import {
  isCheckpointBeforeAgentBatchEnabled,
  getCheckpointState,
  recordCheckpoint,
} from '@pagespace/lib/services/sandbox/checkpoint-policy';
import type { ExecSandboxClient } from '@pagespace/lib/services/sandbox/sandbox-client/types';
import {
  acquireCodeExecutionSlot,
  releaseCodeExecutionSlot,
  checkMachineRuntimeGuardrail,
  recordMachineActivity,
} from '@pagespace/lib/services/sandbox/quota';
import { writeCodeExecutionAudit } from '@pagespace/lib/services/sandbox/audit';
import { gateSandboxToolCall } from '@pagespace/lib/services/sandbox/tool-gate';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { toSubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';
import { createSandboxTools, type ResolveSandboxContext, type SandboxGate } from './sandbox-tools';
import {
  ensureSession,
  provisionSessionSandbox,
  measureWarmSessionStorage,
} from '@/lib/agent-sessions/agent-sessions-runtime';
import type { ToolExecutionContext } from '../core/types';
import { notifyShellAgentActivity } from '@/lib/websocket/socket-utils';

// The Sprites client is a process-wide stateless singleton, built lazily so
// importing this module does no SDK work at load.
let sandboxClientPromise: Promise<ExecSandboxClient> | null = null;

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

/** Wire the real lib deps for the runners (session-anchored acquire + real Sprites driver). */
export function buildRealSandboxRunDeps(): SandboxRunDeps {
  return {
    isEnabled: isCodeExecutionEnabled,
    // The session-anchored acquisition: ensure the conversation's session row,
    // then ensure its Sprite — both through the shared agent-sessions runtime,
    // never a local copy (the CAS only serializes provisioners that all run it).
    acquireSandbox: async (input) => {
      const sessionId = input.conversationId;
      if (!sessionId) {
        // No conversation, no session address — nothing to fold a Sprite key
        // off. resolveSandboxActorContext already refuses this upstream.
        return { ok: false, reason: 'provision_failed', cause: 'missing_conversation_id' };
      }

      // The per-sandbox continuous-runtime backstop, keyed by the session id —
      // the exact discipline the machine path keyed by page id.
      const nowMs = Date.now();
      const guardrail = checkMachineRuntimeGuardrail({ machineKey: sessionId, now: nowMs });
      if (!guardrail.allowed) return { ok: false, reason: guardrail.reason };

      const ensured = await ensureSession({
        conversationId: sessionId,
        userId: input.userId,
        agentPageId: input.agentPageId ?? null,
      });
      if (!ensured.ok) {
        return { ok: false, reason: 'provision_failed', cause: ensured.reason };
      }

      const provisioned = await provisionSessionSandbox(ensured.session, input.userId);
      if (!provisioned.ok) {
        if (provisioned.reason === 'denied') {
          // `not_authorized` is the capability denial the runners already speak
          // (canRunCode's vocabulary); everything else is a provisioning fault.
          return provisioned.denial === 'not_authorized'
            ? { ok: false, reason: 'no_drive_access' }
            : { ok: false, reason: 'provision_failed', cause: provisioned.denial };
        }
        return { ok: false, reason: 'provision_failed', cause: provisioned.detail ?? provisioned.reason };
      }

      recordMachineActivity({ machineKey: sessionId, now: nowMs });

      return {
        ok: true,
        sandboxId: provisioned.sandboxId,
        resumed: provisioned.resumed,
        // The billing/attribution key: the session's agent page when it has
        // one. A global-assistant session has none; the payer resolution's
        // tenant fallback covers it.
        pageId: input.agentPageId,
      };
    },
    reconnect: async (sandboxId) => (await getSandboxClient()).get({ sandboxId }),
    quota: {
      acquireSlot: acquireCodeExecutionSlot,
      releaseSlot: releaseCodeExecutionSlot,
    },
    buildEnv: defaultBuildEnv,
    audit: (input) => writeCodeExecutionAudit({ input }),
    // Activity-visibility seam: stream a successful bash run into the live PTY
    // feed of every shell in this session, so a human watching one of them sees
    // what the agent just did on the sandbox they share. The realtime handler
    // for this has been in place (and tested) since the bridge re-key; this
    // wiring is what makes it reachable. Best-effort — `notifyShellAgentActivity`
    // logs and swallows its own errors, and the runner fires it unawaited.
    // Opportunistic storage measurement. Supplied HERE rather than called from
    // `acquireSandbox`, because the runner fires this seam from `release` — in a
    // `finally`, AFTER the op — and the timing is the whole point: measuring
    // before the op records the pre-write footprint and then lets the throttle
    // suppress the post-write one, so an agent that writes 5 GB stays invisible
    // until the throttle lapses. The seam's own comment says so; an earlier pass
    // of this PR wired a pre-op call anyway and reintroduced exactly that.
    measureStorage: ({ sandbox, sessionId }) =>
      measureWarmSessionStorage({
        sessionId,
        // The exec client exposes `runCommand`; the measurement seam speaks the
        // host's `exec`. One adapter here beats widening either contract.
        attach: async () => ({ exec: (args) => sandbox.runCommand(args) }),
      }),
    notifyShellActivity: (input) => notifyShellAgentActivity(input),
    // Injection seam (DEFENSE-IN-DEPTH, fail-open): screen untrusted tool output
    // through the built-in heuristic classifier before it becomes a model message.
    // Annotates flagged content (never blocks); a classifier error fails open. A
    // model-based classifier can replace `heuristicInjectionClassifier` here.
    screenOutput: (text) =>
      screenToolOutput({
        text,
        classifier: heuristicInjectionClassifier,
        onFlagged: (verdict) =>
          loggers.ai.warn?.('Sandbox tool output flagged by injection seam (annotated, not blocked)', {
            label: verdict.label,
          }),
        onError: (error) =>
          loggers.ai.error(
            'Sandbox injection classifier errored (failing open)',
            error instanceof Error ? error : new Error(String(error)),
          ),
      }),
    now: () => new Date(),
    logger: loggers.ai,
    // Meter this run's active-runtime cost against the session's payer (the
    // agent page's drive owner, or the acting tenant for a global session).
    billing: defaultSandboxBillingDeps,
    // Sprites Platform Alignment 5-2: checkpoint the sandbox filesystem before
    // an agent bash batch runs (fail-open, at most once per turn — see
    // checkpoint-policy.ts). State is in-process, keyed by sandboxId; a
    // process restart simply re-checkpoints on the next batch, which is
    // harmless (COW, ~300ms).
    checkpoint: {
      isEnabled: isCheckpointBeforeAgentBatchEnabled,
      getState: getCheckpointState,
      recordCheckpoint,
      createCheckpoint: ({ sandbox, comment }) => sandbox.createCheckpoint(comment),
    },
  };
}

/**
 * Lazily stamp a stable turn id onto `context` the first time it's read, then
 * return it. `context` is the SAME object reference for every tool call
 * within one streamText run, so this stamps once per agent turn and every
 * later bash call in the run sees the value already set. Undefined `context`
 * (no tool-execution context at all) stays undefined — there is nothing to
 * stamp onto.
 */
function stampTurnId(context: ToolExecutionContext | undefined): string | undefined {
  if (!context) return undefined;
  context.turnId ??= crypto.randomUUID();
  return context.turnId;
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

    const turnId = stampTurnId(context);
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

    // One parallel fetch covers both branches below: `findDrive` only runs a
    // real query when driveId is present (an immediately-resolved undefined
    // otherwise), so this preserves the original concurrency — findDrive,
    // findUser, and getActorInfo all in flight together — without duplicating
    // the actor lookup + result-object construction per branch.
    const [drive, actorRow, actorInfo] = await Promise.all([
      driveId ? deps.findDrive(driveId) : Promise.resolve(undefined),
      deps.findUser(userId),
      deps.getActorInfo(userId),
    ]);
    if (driveId && !drive) return { error: 'Code execution requires an active drive.' };

    const base = {
      userId,
      conversationId,
      requestOrigin: context?.requestOrigin,
      agentPageId: context?.chatSource?.agentPageId ?? context?.parentAgentId,
      actorEmail: actorInfo.actorEmail,
      actorDisplayName: actorInfo.actorDisplayName,
      aiProvider: context?.aiProvider,
      aiModel: context?.aiModel,
      tier: toSubscriptionTier(actorRow?.subscriptionTier),
      turnId,
    };

    // driveId present for both page AI and global AI: tenantId is the drive's
    // owning account. Both surfaces share identical resolution logic here.
    if (driveId) {
      return { ...base, tenantId: drive!.ownerId, driveId };
    }

    // Global AI without a drive: user is their own isolation boundary.
    // tenantId = userId keeps the session key and quota scopes user-owned.
    return { ...base, tenantId: userId };
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

/** The shared call-time gate binding — kill-switch, canRunCode, quota preflight. */
export const productionSandboxGate: SandboxGate = (ctx) =>
  gateSandboxToolCall({
    userId: ctx.userId,
    driveId: ctx.driveId,
    tenantId: ctx.tenantId,
    requestOrigin: ctx.requestOrigin,
    agentPageId: ctx.agentPageId,
    tier: ctx.tier,
  });

/**
 * Production sandbox tools, fully wired. Registered behind the default-OFF
 * CODE_EXECUTION kill-switch — importing this object does not expose anything
 * by itself.
 */
export function buildSandboxTools(): {
  bash: Tool;
  writeFile: Tool;
  readFile: Tool;
  editFile: Tool;
} {
  return createSandboxTools({
    runDeps: buildRealSandboxRunDeps(),
    resolveContext: resolveSandboxActorContext,
    gate: productionSandboxGate,
  });
}
