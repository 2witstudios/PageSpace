/**
 * Production wiring for the agent-session services (`@pagespace/lib`
 * services/agent-sessions) — DI of the DB-backed stores, the Sprites host, the
 * squat-guarded conversation creators, and the permission/capability lookups.
 *
 * ZERO decision logic lives here, by mandate: every `if` below turns a null
 * into another null (no page → no page permission to fetch; no drive → no
 * drive-scoped authorization input). Anything that WEIGHS these facts lives in
 * `packages/lib/src/agent-sessions/` (the pure deciders/planners) and is
 * executed by the services this module merely binds.
 *
 * Mirrors the `apps/web/src/lib/machines/*-runtime.ts` discipline: lazy
 * memoized async singletons for the store and the Sprites host (the
 * `@fly/sprites` SDK is ESM/Node-24-only and must never be statically
 * imported), `build<Verb>Deps` functions that adapt store methods one-by-one so
 * the deps surface stays the narrow `Pick<>` each service declared, and entry
 * wrappers that return result unions — never throws — for the routes to map.
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages, drives } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { checkAgentSessionConcurrency } from '@pagespace/lib/services/sandbox/quota';
import { refreshSessionStorageMeasurement } from '@pagespace/lib/services/sandbox/sandbox-storage-measure';
import { toSubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';
import type { SandboxHost } from '@pagespace/lib/services/sandbox/sandbox-host';
import { canRunCode, isCodeExecutionEnabled } from '@pagespace/lib/services/sandbox/can-run-code';
import {
  decideFullEgressEnablement,
  isContainmentVerified,
} from '@pagespace/lib/services/sandbox/containment';
import { getSandboxSessionSecret } from '@pagespace/lib/services/sandbox/machine-session-manager';
import { resolveSandboxNetworkOptions } from '@pagespace/lib/services/sandbox/network-options';
import { getConfiguredEgressIpTag } from '@pagespace/lib/services/sandbox/egress-ip';
import { canUserViewPage, canUserEditPage } from '@pagespace/lib/permissions/permissions';
import {
  ensureAgentSession,
  endAgentSession,
  listAgentSessions,
  toAgentSessionDTO,
  type EnsureAgentSessionResult,
  type EndAgentSessionResult,
} from '@pagespace/lib/services/agent-sessions/agent-sessions';
import {
  createDbAgentSessionStore,
  type AgentSessionListFilter,
  type AgentSessionRecord,
  type AgentSessionStore,
} from '@pagespace/lib/services/agent-sessions/agent-sessions-store';
import {
  ensureAgentSessionSandbox,
  type EnsureAgentSessionSandboxResult,
} from '@pagespace/lib/services/agent-sessions/agent-session-sprite';
import {
  checkAgentSessionAccess,
  checkAgentSessionEndAccess,
  type AgentSessionAccessCheck,
  type AgentSessionAccessDeps,
} from '@pagespace/lib/services/agent-sessions/agent-session-access';
import type { AgentSessionDTO } from '@pagespace/lib/agent-sessions/contract';
import { decideAgentSessionAccess } from '@pagespace/lib/agent-sessions/decide-session-access';
import { conversationRepository } from '@/lib/repositories/conversation-repository';
import {
  resolveOrCreateConversation,
  ConversationOwnershipError,
} from '@/app/api/ai/global/[id]/messages/resolve-or-create-conversation';

export { isCodeExecutionEnabled };

// ---------------------------------------------------------------------------
// Lazy singletons — the store reconnects to one DB pool; the host is stateless.
// Both are built on first use so importing this module does no DB or SDK work.
// ---------------------------------------------------------------------------

let sessionStorePromise: ReturnType<typeof createDbAgentSessionStore> | null = null;

export function getAgentSessionStore(): Promise<AgentSessionStore> {
  sessionStorePromise ??= createDbAgentSessionStore();
  return sessionStorePromise;
}

// The Fly Sprites driver is loaded via a DYNAMIC import, never a static one —
// @fly/sprites is ESM-only and @pagespace/lib compiles to CJS (see
// sandbox-tools-runtime.ts for the full rationale). Fail CLOSED with an
// actionable message on a pre-Node-24 runtime, and never memoize a rejection.
const MIN_SANDBOX_NODE_MAJOR = 24;

function assertSandboxRuntime(): void {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (Number.isNaN(major) || major < MIN_SANDBOX_NODE_MAJOR) {
    throw new Error(
      `Agent sessions require Node.js >= ${MIN_SANDBOX_NODE_MAJOR} ` +
        `(the @fly/sprites SDK is Node ${MIN_SANDBOX_NODE_MAJOR}+ / ESM-only); ` +
        `this process is Node ${process.versions.node}.`,
    );
  }
}

let machineHostPromise: Promise<SandboxHost> | null = null;

export function getSandboxHost(): Promise<SandboxHost> {
  machineHostPromise ??= (async () => {
    assertSandboxRuntime();
    const { createProductionSandboxHost } = await import('@/lib/sandbox/sprites-client');
    return createProductionSandboxHost();
  })().catch((error) => {
    machineHostPromise = null;
    throw error;
  });
  return machineHostPromise;
}

// ---------------------------------------------------------------------------
// Row-fact lookups (null-plumbing only)
// ---------------------------------------------------------------------------

/** The agent page's drive, or null when the page (or its drive) cannot be resolved. */
export async function resolveAgentPageDriveId(agentPageId: string): Promise<string | null> {
  const page = await db.query.pages.findFirst({
    where: eq(pages.id, agentPageId),
    columns: { driveId: true },
  });
  return page?.driveId ?? null;
}

/**
 * The tenant a session's Sprite key folds under: the agent page's drive OWNER
 * for a page-anchored session, the session owner themself for a global one
 * (the user is their own isolation boundary — same rule as
 * `resolveSandboxActorContext`).
 */
export async function resolveSessionTenantId(session: {
  agentPageId: string | null;
  ownerId: string;
}): Promise<string> {
  if (session.agentPageId === null) return session.ownerId;
  const driveId = await resolveAgentPageDriveId(session.agentPageId);
  if (driveId === null) return session.ownerId;
  const drive = await db.query.drives.findFirst({
    where: eq(drives.id, driveId),
    columns: { ownerId: true },
  });
  return drive?.ownerId ?? session.ownerId;
}

export interface SessionConversationFacts {
  userId: string;
  type: string;
  contextId: string | null;
  isShared: boolean;
}

/** The conversation row's identity facts, or null when it does not exist. */
export async function findSessionConversation(
  conversationId: string,
): Promise<SessionConversationFacts | null> {
  const row = await conversationRepository.getConversation(conversationId);
  if (!row) return null;
  return { userId: row.userId, type: row.type, contextId: row.contextId, isShared: row.isShared };
}

export async function findSessionRecord(sessionId: string): Promise<AgentSessionRecord | null> {
  return (await getAgentSessionStore()).findById(sessionId);
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

function buildAccessDeps(): AgentSessionAccessDeps {
  return {
    findSession: async (sessionId) => {
      const row = await findSessionRecord(sessionId);
      if (!row) return null;
      return { sessionId: row.conversationId, ownerId: row.ownerId, agentPageId: row.agentPageId };
    },
    resolveConversationOwnership: async ({ conversationId, requesterId }) => {
      const conversation = await findSessionConversation(conversationId);
      if (!conversation) return 'none';
      if (conversation.userId === requesterId) return 'owner';
      return conversation.isShared ? 'shared' : 'none';
    },
    resolvePagePermission: async ({ userId, agentPageId }) => {
      if (await canUserEditPage(userId, agentPageId)) return 'edit';
      if (await canUserViewPage(userId, agentPageId)) return 'view';
      return 'none';
    },
    canRunCode: async ({ userId, agentPageId }) => {
      const driveId = agentPageId === null ? null : await resolveAgentPageDriveId(agentPageId);
      const result = await canRunCode({
        userId,
        driveId: driveId ?? undefined,
        requestOrigin: 'user',
      });
      return result.ok;
    },
  };
}

export async function checkSessionAccess(
  requesterId: string,
  sessionId: string,
): Promise<AgentSessionAccessCheck> {
  return checkAgentSessionAccess({ requesterId, sessionId, deps: buildAccessDeps() });
}

/**
 * The same ONE pure decision, applied to a session that may not have a row yet
 * — the ensure path's subject is synthesized from the conversation row it is
 * about to anchor to (`sessionId` ≡ conversationId, `ownerId` = the
 * conversation's owner). This gathers the identical facts `buildAccessDeps`
 * gathers and hands them to `decideAgentSessionAccess`; no fifth fact and no
 * extra rule exists here.
 */
export async function checkAccessForSubject(
  requesterId: string,
  subject: { sessionId: string; ownerId: string; agentPageId: string | null },
): Promise<AgentSessionAccessCheck> {
  const deps = buildAccessDeps();
  const [conversationOwnership, pagePermission, allowedToRunCode] = await Promise.all([
    deps.resolveConversationOwnership({ conversationId: subject.sessionId, requesterId }),
    subject.agentPageId === null
      ? Promise.resolve(null)
      : deps.resolvePagePermission({ userId: requesterId, agentPageId: subject.agentPageId }),
    deps.canRunCode({ userId: requesterId, agentPageId: subject.agentPageId }),
  ]);
  return decideAgentSessionAccess({
    requesterId,
    session: subject,
    conversationOwnership,
    pagePermission,
    canRunCode: allowedToRunCode,
  });
}

export async function checkSessionEndAccess(
  requesterId: string,
  sessionId: string,
): Promise<AgentSessionAccessCheck> {
  const { findSession, resolveConversationOwnership, resolvePagePermission } = buildAccessDeps();
  return checkAgentSessionEndAccess({
    requesterId,
    sessionId,
    deps: { findSession, resolveConversationOwnership, resolvePagePermission },
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * The squat-guarded conversation creators, one per anchor kind. Injected into
 * `ensureAgentSession` so the guard in the app repository stays the ONLY way a
 * conversation id is ever claimed (see `EnsureConversationFn`'s doc).
 * `resolveOrCreateConversation` throws `ConversationOwnershipError` for a
 * conversation someone else owns — rethrown as-is for the service to fold into
 * its `conversation_unavailable` result.
 */
async function ensureConversationRow({
  conversationId,
  userId,
  agentPageId,
}: {
  conversationId: string;
  userId: string;
  agentPageId: string | null;
}): Promise<void> {
  if (agentPageId === null) {
    try {
      await resolveOrCreateConversation(userId, conversationId);
    } catch (error) {
      if (error instanceof ConversationOwnershipError) {
        throw new Error('conversation_unavailable');
      }
      throw error;
    }
    return;
  }
  await conversationRepository.createConversation(conversationId, userId, agentPageId);
}

export async function ensureSession(input: {
  conversationId: string;
  userId: string;
  agentPageId: string | null;
  name?: string | null;
}): Promise<EnsureAgentSessionResult> {
  const store = await getAgentSessionStore();
  return ensureAgentSession({
    userId: input.userId,
    agentPageId: input.agentPageId,
    conversationId: input.conversationId,
    name: input.name,
    deps: {
      store,
      ensureConversation: ensureConversationRow,
      now: () => new Date(),
    },
  });
}

/**
 * Provision (or resume/adopt) a session row's sandbox — the ONE code path both
 * the web app and the realtime bridge use, per `agent-session-sprite.ts`'s CAS
 * doc. `requesterId` is who this provision authorizes as.
 */
export async function provisionSessionSandbox(
  row: AgentSessionRecord,
  requesterId: string,
): Promise<EnsureAgentSessionSandboxResult> {
  const [store, host, tenantId] = await Promise.all([
    getAgentSessionStore(),
    getSandboxHost(),
    resolveSessionTenantId(row),
  ]);

  // Per-owner live-session ceiling. Enforced HERE because this is the one path
  // every first touch funnels through (a chat tool call, a POST to the session
  // route, opening a shell) — checking at any single caller would leave the
  // others free to provision past the tier limit.
  //
  // Resumes are exempt (see `alreadyProvisioned` below) — that judgement lives
  // in the quota module so the ceiling has one place it can be wrong.
  const owner = await db.query.users.findFirst({
    where: eq(users.id, row.ownerId),
    columns: { subscriptionTier: true },
  });
  const quota = await checkAgentSessionConcurrency({
    ownerId: row.ownerId,
    tier: toSubscriptionTier(owner?.subscriptionTier),
    countLiveAgentSessions: (ownerId) => store.countLive(ownerId),
    // A row already carrying a sandbox is a RESUME, already counted by
    // countLive; the skip itself is decided inside the quota module.
    alreadyProvisioned: row.sandboxId !== null,
  });
  if (!quota.allowed) {
    return {
      ok: false,
      reason: 'denied',
      denial: 'not_authorized',
      detail:
        'live agent-session limit reached for your plan — end an existing session before starting another',
    };
  }

  return ensureAgentSessionSandbox({
    row: { ...row, sessionId: row.conversationId },
    intent: 'ensure',
    actor: { userId: requesterId, tenantId },
    deps: {
      store,
      host,
      substrate: { kind: 'sprite' },
      options: resolveSandboxNetworkOptions({ surface: 'machine', egressIpTag: getConfiguredEgressIpTag() }),
      secret: getSandboxSessionSecret(),
      authorize: canRunCode,
      resolveDriveId: resolveAgentPageDriveId,
      checkFullEgressEnablement: async () =>
        decideFullEgressEnablement({
          adminGateEnabled: isCodeExecutionEnabled(),
          containment: isContainmentVerified() ? { contained: true } : null,
        }),
      // Opportunistic storage measurement, captured while the Sprite is still
      // awake right after provisioning — the one moment its bytes are free to
      // read. Without this the reconcile has no writer for
      // `storageMeasuredBytes` and prices every session at the never-measured
      // 0 floor while still advancing its watermark, silently discarding the
      // interval. Fire-and-forget inside the seam; throttled per session.
      measureSessionStorage: async ({ sessionId, handle }) => {
        await refreshSessionStorageMeasurement({
          handle,
          sessionId,
          lastMeasuredAt: row.storageMeasuredAt ?? null,
          now: new Date(),
          persist: (measurement) => store.recordStorageMeasurement(measurement),
        });
      },
      now: () => new Date(),
    },
  });
}

export async function endSession(sessionId: string): Promise<EndAgentSessionResult> {
  const [store, host] = await Promise.all([getAgentSessionStore(), getSandboxHost()]);
  return endAgentSession({ sessionId, deps: { store, host, now: () => new Date() } });
}

export async function listSessions(filter: AgentSessionListFilter): Promise<AgentSessionDTO[]> {
  const store = await getAgentSessionStore();
  return listAgentSessions({ filter, deps: { store } });
}

export { toAgentSessionDTO };
export type { AgentSessionRecord, AgentSessionListFilter };
