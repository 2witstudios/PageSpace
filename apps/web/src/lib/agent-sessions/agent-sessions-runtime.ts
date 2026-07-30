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
import { and, desc, eq, isNotNull } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { users } from '@pagespace/db/schema/auth';
import { checkAgentSessionConcurrency } from '@pagespace/lib/services/sandbox/quota';
import {
  refreshSessionStorageMeasurement,
  shouldRefreshMeasurement,
  SESSION_STORAGE_MEASUREMENT_THROTTLE_MS,
} from '@pagespace/lib/services/sandbox/sandbox-storage-measure';
import { toSubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';
import type { SandboxHandle, SandboxHost } from '@pagespace/lib/services/sandbox/sandbox-host';
import { canRunCode, isCodeExecutionEnabled } from '@pagespace/lib/services/sandbox/can-run-code';
import {
  decideFullEgressEnablement,
  isContainmentVerified,
} from '@pagespace/lib/services/sandbox/containment';
import { getSandboxSessionSecret } from '@pagespace/lib/services/sandbox/machine-session-manager';
import { resolveSandboxNetworkOptions } from '@pagespace/lib/services/sandbox/network-options';
import { getConfiguredEgressIpTag } from '@pagespace/lib/services/sandbox/egress-ip';
import {
  spawnAgentSession,
  endAgentSession,
  listAgentSessions,
  toAgentSessionDTO,
  type SpawnAgentSessionResult,
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
import { resolveOrCreateConversation } from '@/app/api/ai/global/[id]/messages/resolve-or-create-conversation';
import { createConversationInSessionWith } from '@/lib/agent-sessions/create-conversation-in-session';

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

/**
 * The tenant a session's Sprite key folds under: the agent page's drive OWNER
 * for a page-anchored session, the session owner themself for a global one
 * (the user is their own isolation boundary — same rule as
 * `resolveSandboxActorContext`).
 */
export async function resolveSessionTenantId(session: {
  driveId: string | null;
  ownerId: string;
}): Promise<string> {
  if (session.driveId === null) return session.ownerId;
  const drive = await db.query.drives.findFirst({
    where: eq(drives.id, session.driveId),
    columns: { ownerId: true },
  });
  return drive?.ownerId ?? session.ownerId;
}

export async function findSessionRecord(sessionId: string): Promise<AgentSessionRecord | null> {
  return (await getAgentSessionStore()).findById(sessionId);
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/**
 * The requester's relationship to a drive: its owner, an accepted member, or
 * neither. The ONE membership read both access checks share.
 */
export async function resolveDriveMembership({
  userId,
  driveId,
}: {
  userId: string;
  driveId: string;
}): Promise<'owner' | 'member' | 'none'> {
  const drive = await db.query.drives.findFirst({
    where: eq(drives.id, driveId),
    columns: { ownerId: true },
  });
  if (!drive) return 'none';
  if (drive.ownerId === userId) return 'owner';
  const membership = await db.query.driveMembers.findFirst({
    where: and(eq(driveMembers.driveId, driveId), eq(driveMembers.userId, userId), isNotNull(driveMembers.acceptedAt)),
    columns: { id: true },
  });
  return membership ? 'member' : 'none';
}

function buildAccessDeps(): AgentSessionAccessDeps {
  return {
    findSession: async (sessionId) => {
      const row = await findSessionRecord(sessionId);
      if (!row) return null;
      return { sessionId: row.id, ownerId: row.ownerId, driveId: row.driveId };
    },
    resolveDriveMembership,
    canRunCode: async ({ userId, driveId }) => {
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
 * The same ONE pure decision, applied BEFORE a row exists — the spawn path's
 * subject is the session about to be minted (`ownerId` = the requester,
 * `driveId` = where it will live). This gathers the identical facts
 * `buildAccessDeps` gathers and hands them to `decideAgentSessionAccess`; no
 * extra rule exists here.
 */
export async function checkAccessForSubject(
  requesterId: string,
  subject: { sessionId: string; ownerId: string; driveId: string | null },
): Promise<AgentSessionAccessCheck> {
  const deps = buildAccessDeps();
  const [driveMembership, allowedToRunCode] = await Promise.all([
    subject.driveId === null
      ? Promise.resolve(null)
      : deps.resolveDriveMembership({ userId: requesterId, driveId: subject.driveId }),
    deps.canRunCode({ userId: requesterId, driveId: subject.driveId }),
  ]);
  return decideAgentSessionAccess({
    requesterId,
    session: subject,
    driveMembership,
    canRunCode: allowedToRunCode,
  });
}

export async function checkSessionEndAccess(
  requesterId: string,
  sessionId: string,
): Promise<AgentSessionAccessCheck> {
  return checkAgentSessionEndAccess({
    requesterId,
    sessionId,
    deps: buildAccessDeps(),
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Create a conversation BORN INTO a session. Decision logic lives in the pure
 * module (`create-conversation-in-session.ts`) — this is only its production
 * wiring: the squat-guarded repository creator for page threads, the
 * ownership-guarded resolver for global ones, both carrying the binding
 * INSIDE their INSERT (no `conversations.sessionId` UPDATE exists anywhere —
 * rebinding is unrepresentable, per invariant 1).
 *
 * Throws `ConversationUnavailableError` (message `conversation_unavailable`)
 * when the id cannot be claimed WITH this binding — foreign owner, legacy
 * message-owner conflict, or an existing row whose binding disagrees.
 */
export async function createConversationInSession(input: {
  conversationId: string;
  userId: string;
  /** null = a global-assistant conversation. */
  agentPageId: string | null;
  sessionId: string;
}): Promise<void> {
  return createConversationInSessionWith(
    {
      createPageConversation: ({ conversationId, userId, agentPageId, sessionId }) =>
        conversationRepository.createConversation(conversationId, userId, agentPageId, { sessionId }),
      createGlobalConversation: async ({ conversationId, userId, sessionId }) => {
        await resolveOrCreateConversation(userId, conversationId, undefined, { sessionId });
      },
      findConversation: async (conversationId) => {
        const row = await conversationRepository.getConversation(conversationId);
        if (!row) return null;
        return { userId: row.userId, type: row.type, contextId: row.contextId, sessionId: row.sessionId };
      },
    },
    input,
  );
}

export async function spawnSession(input: {
  userId: string;
  driveId: string | null;
  name?: string | null;
}): Promise<SpawnAgentSessionResult> {
  const store = await getAgentSessionStore();
  return spawnAgentSession({
    ownerId: input.userId,
    driveId: input.driveId,
    name: input.name,
    deps: { store, now: () => new Date() },
  });
}

/** Resolve a conversation's session — how a chat turn finds its working context. Null = a plain chat. */
export async function findSessionForConversation(conversationId: string): Promise<AgentSessionRecord | null> {
  return (await getAgentSessionStore()).findByConversation(conversationId);
}

export interface SessionConversationEntry {
  conversationId: string;
  title: string | null;
  /** The thread's agent page (`contextId` for a page chat), or null for a global-assistant thread. */
  agentPageId: string | null;
  lastMessageAt: Date | null;
}

/** The conversations living in one session, newest activity first — the sidebar's expansion list. */
export async function listSessionConversations(sessionId: string): Promise<SessionConversationEntry[]> {
  const rows = await db
    .select({
      conversationId: conversations.id,
      title: conversations.title,
      type: conversations.type,
      contextId: conversations.contextId,
      lastMessageAt: conversations.lastMessageAt,
    })
    .from(conversations)
    .where(and(eq(conversations.sessionId, sessionId), eq(conversations.isActive, true)))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(100);
  return rows.map((row) => ({
    conversationId: row.conversationId,
    title: row.title,
    agentPageId: row.type === 'page' ? row.contextId : null,
    lastMessageAt: row.lastMessageAt,
  }));
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

  return ensureAgentSessionSandbox({
    row: { ...row, sessionId: row.id },
    intent: 'ensure',
    actor: { userId: requesterId, tenantId },
    deps: {
      store,
      host,
      substrate: { kind: 'sprite' },
      options: resolveSandboxNetworkOptions({ surface: 'machine', egressIpTag: getConfiguredEgressIpTag() }),
      secret: getSandboxSessionSecret(),
      authorize: canRunCode,
      checkFullEgressEnablement: async () =>
        decideFullEgressEnablement({
          adminGateEnabled: isCodeExecutionEnabled(),
          containment: isContainmentVerified() ? { contained: true } : null,
        }),
      checkConcurrency: async ({ ownerId, alreadyProvisioned }) => {
        const owner = await db.query.users.findFirst({
          where: eq(users.id, ownerId),
          columns: { subscriptionTier: true },
        });
        return checkAgentSessionConcurrency({
          ownerId,
          tier: toSubscriptionTier(owner?.subscriptionTier),
          countLiveAgentSessions: (id) => store.countLive(id),
          alreadyProvisioned,
        });
      },
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
          // NULL, not the row's value: this callback only fires on the `create`
          // arm, where the same operation resets the measurement columns (a new
          // Sprite generation is an empty filesystem). Passing the pre-provision
          // timestamp would let the throttle skip the baseline measurement of a
          // session re-provisioned inside the window, leaving the row null with
          // no other trigger to fix it.
          lastMeasuredAt: null,
          now: new Date(),
          persist: (measurement) => store.recordStorageMeasurement(measurement),
        });
      },
      now: () => new Date(),
    },
  });
}

/**
 * Opportunistically measure a WARM session's storage.
 *
 * The provisioner's own `measureSessionStorage` only fires on `create`, against
 * a filesystem that is empty by definition — so on its own it pins every session
 * at the baseline forever while the reconcile keeps advancing the watermark. The
 * figure that actually matters is the one taken while the agent is doing real
 * work, which is what this is for: call it where a sandbox is already awake and
 * a handle is cheap. Throttled per session (default 1h), so a burst of tool
 * calls costs at most one `du`.
 *
 * Fire-and-forget by contract: a billing observation must never fail, delay, or
 * be awaited by the work that triggered it.
 */
export async function measureWarmSessionStorage(input: {
  sessionId: string;
  attach: () => Promise<{ exec: SandboxHandle['exec'] } | null>;
}): Promise<void> {
  try {
    const store = await getAgentSessionStore();
    const row = await store.findById(input.sessionId);
    // Only a live row is worth measuring, and only when the throttle has elapsed
    // — checked BEFORE attaching so the common case costs one indexed read.
    if (!row || row.sandboxId === null || row.spriteTornDownAt !== null) return;
    if (!shouldRefreshMeasurement({
      lastMeasuredAt: row.storageMeasuredAt ?? null,
      now: new Date(),
      throttleMs: SESSION_STORAGE_MEASUREMENT_THROTTLE_MS,
    })) return;

    const handle = await input.attach();
    if (!handle) return;
    await refreshSessionStorageMeasurement({
      handle,
      sessionId: input.sessionId,
      lastMeasuredAt: row.storageMeasuredAt ?? null,
      now: new Date(),
      persist: (measurement) => store.recordStorageMeasurement(measurement),
    });
  } catch {
    // Best-effort: never let a billing observation surface as a tool failure.
  }
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
