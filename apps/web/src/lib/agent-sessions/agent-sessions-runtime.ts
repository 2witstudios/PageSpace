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
import { and, count, eq, inArray, isNull, isNotNull, sql, desc } from '@pagespace/db/operators';
import { conversations } from '@pagespace/db/schema/conversations';
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
import {
  resolveSessionTenantId,
  resolveDriveMembership,
  canRunCodeForSession,
} from '@pagespace/lib/services/agent-sessions/agent-session-tenant';
import type { AgentSessionDTO } from '@pagespace/lib/agent-sessions/contract';
import { decideAgentSessionAccess } from '@pagespace/lib/agent-sessions/decide-session-access';
import { MAX_SESSION_CONVERSATIONS } from '@pagespace/lib/agent-sessions/plan-spawn-session';
import { conversationRepository } from '@/lib/repositories/conversation-repository';
import { resolveOrCreateConversation } from '@/app/api/ai/global/[id]/messages/resolve-or-create-conversation';
import { createConversationInSessionWith } from '@/lib/agent-sessions/create-conversation-in-session';
import {
  closeConversationInSessionWith,
  type CloseConversationOutcome,
} from '@/lib/agent-sessions/close-conversation-in-session';
import {
  reopenConversationInSessionWith,
  type ReopenConversationOutcome,
} from '@/lib/agent-sessions/reopen-conversation-in-session';

export { isCodeExecutionEnabled };

/**
 * The most NOT-ENDED sessions one owner may hold. Spawn is deliberately
 * instant and free (no sandbox), which meant the live-sandbox concurrency
 * quota never applied to it — an authorized caller could mint unbounded rows
 * (review M6/F4). The single source of truth: `spawnSession` below passes it
 * as `spawnAgentSession`'s REQUIRED `maxActiveSessions` dep (review
 * #2261/2), and the route imports it for its own advisory pre-check.
 */
export const MAX_ACTIVE_SESSIONS_PER_OWNER = 100;

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

/** The owner's not-ended session count — the spawn ceiling's input (store.countActive). */
export async function countActiveSessionsForOwner(ownerId: string): Promise<number> {
  return (await getAgentSessionStore()).countActive(ownerId);
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
      return { sessionId: row.id, ownerId: row.ownerId, driveId: row.driveId };
    },
    resolveDriveMembership,
    canRunCode: canRunCodeForSession,
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
  /** Display label written at birth (a spawned worker's name). */
  title?: string | null;
}): Promise<void> {
  return createConversationInSessionWith(
    {
      createPageConversation: ({ conversationId, userId, agentPageId, sessionId, title }) =>
        conversationRepository.createConversation(conversationId, userId, agentPageId, {
          sessionId,
          title: title ?? undefined,
        }),
      createGlobalConversation: async ({ conversationId, userId, sessionId, title }) => {
        await resolveOrCreateConversation(userId, conversationId, undefined, {
          sessionId,
          title: title ?? undefined,
        });
      },
      findConversation: async (conversationId) => {
        const row = await conversationRepository.getConversation(conversationId);
        if (!row) return null;
        return { userId: row.userId, type: row.type, contextId: row.contextId, sessionId: row.sessionId };
      },
      findAgentDriveId: async (agentPageId) => {
        const agent = await conversationRepository.getAiAgent(agentPageId);
        return agent?.driveId ?? null;
      },
      findSessionDriveId: async (sessionId) => {
        const row = await findSessionRecord(sessionId);
        return row ? { driveId: row.driveId } : null;
      },
      countActiveConversations: async (sessionId) => {
        const [row] = await db
          .select({ n: count() })
          .from(conversations)
          .where(
            and(
              eq(conversations.sessionId, sessionId),
              eq(conversations.isActive, true),
              // A conversation closed OUT of the session's listing no longer
              // holds a cap slot — closing one frees room for another.
              isNull(conversations.closedInSessionAt),
            ),
          );
        return row?.n ?? 0;
      },
    },
    input,
  );
}

/**
 * Close a conversation OUT of its session's listing — the transactional
 * wiring for `close-conversation-in-session.ts`'s pure decision. A per-session
 * advisory lock (the `agent-sessions-store.ts` `createIfUnderLimit` pattern)
 * serializes concurrent closes of THIS session's listings, so two racing
 * closes of the last two open conversations cannot both read "more than one
 * open" and both succeed — the second sees the first's write and gets
 * `last_conversation`.
 */
export async function closeConversationInSession(input: {
  conversationId: string;
  sessionId: string;
}): Promise<CloseConversationOutcome> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${'agent-session-conversations:' + input.sessionId}))`,
    );
    return closeConversationInSessionWith(
      {
        findConversation: async (conversationId) => {
          const [row] = await tx
            .select({
              sessionId: conversations.sessionId,
              closedInSessionAt: conversations.closedInSessionAt,
              isActive: conversations.isActive,
            })
            .from(conversations)
            .where(eq(conversations.id, conversationId))
            .limit(1);
          return row ?? null;
        },
        countOpenConversations: async (sessionId) => {
          const [row] = await tx
            .select({ n: count() })
            .from(conversations)
            .where(
              and(
                eq(conversations.sessionId, sessionId),
                eq(conversations.isActive, true),
                isNull(conversations.closedInSessionAt),
              ),
            );
          return row?.n ?? 0;
        },
        closeConversation: async (conversationId) => {
          const updated = await tx
            .update(conversations)
            .set({ closedInSessionAt: new Date() })
            .where(and(eq(conversations.id, conversationId), isNull(conversations.closedInSessionAt)))
            .returning({ id: conversations.id });
          return updated.length > 0 ? 'closed' : 'noop';
        },
      },
      input,
    );
  });
}

/**
 * Reopen a conversation OUT of "closed" and back into its session's
 * listing — the transactional wiring for `reopen-conversation-in-session.ts`'s
 * pure decision. Same per-session advisory lock as `closeConversationInSession`
 * (same lock key), so a reopen can never race a close — or another reopen —
 * of the same session's listings.
 */
export async function reopenConversationInSession(input: {
  conversationId: string;
  sessionId: string;
}): Promise<ReopenConversationOutcome> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${'agent-session-conversations:' + input.sessionId}))`,
    );
    return reopenConversationInSessionWith(
      {
        findConversation: async (conversationId) => {
          const [row] = await tx
            .select({
              sessionId: conversations.sessionId,
              closedInSessionAt: conversations.closedInSessionAt,
              isActive: conversations.isActive,
            })
            .from(conversations)
            .where(eq(conversations.id, conversationId))
            .limit(1);
          return row ?? null;
        },
        countOpenConversations: async (sessionId) => {
          const [row] = await tx
            .select({ n: count() })
            .from(conversations)
            .where(
              and(
                eq(conversations.sessionId, sessionId),
                eq(conversations.isActive, true),
                isNull(conversations.closedInSessionAt),
              ),
            );
          return row?.n ?? 0;
        },
        reopenConversation: async (conversationId) => {
          const updated = await tx
            .update(conversations)
            .set({ closedInSessionAt: null })
            .where(and(eq(conversations.id, conversationId), isNotNull(conversations.closedInSessionAt)))
            .returning({ id: conversations.id });
          return updated.length > 0 ? 'reopened' : 'noop';
        },
      },
      input,
    );
  });
}

/**
 * A session's CLOSED conversations — the reopen affordance's listing. Mirrors
 * `listSessionConversationsBulk`'s shape and cap for a single session, with
 * the closed/open predicate flipped: `isActive` still gates history-deleted
 * rows out, but `closedInSessionAt` must be SET rather than null. Newest
 * activity first, capped at {@link MAX_SESSION_CONVERSATIONS} — history
 * beyond that is reachable through the agent's own page History tab, not
 * this session-scoped reopen list.
 */
export async function listClosedSessionConversations(sessionId: string): Promise<SessionConversationEntry[]> {
  const rows = await db
    .select({
      conversationId: conversations.id,
      title: conversations.title,
      type: conversations.type,
      contextId: conversations.contextId,
      lastMessageAt: conversations.lastMessageAt,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.sessionId, sessionId),
        eq(conversations.isActive, true),
        isNotNull(conversations.closedInSessionAt),
      ),
    )
    .orderBy(desc(conversations.lastMessageAt))
    .limit(MAX_SESSION_CONVERSATIONS);

  return rows.map((row) => ({
    conversationId: row.conversationId,
    title: row.title,
    // Same mapping `listSessionConversationsBulk` uses: `contextId` is only
    // meaningful as an agent page id for a 'page' conversation.
    agentPageId: row.type === 'page' ? row.contextId : null,
    lastMessageAt: row.lastMessageAt,
  }));
}

/**
 * A plain, lock-free, INFORMATIONAL read — not a guard. Ending a session is a
 * genuinely unconditional act (the sidebar's own "End session" is reachable
 * with any number of open conversations, by design), so this never blocks
 * `endSession`; it exists only so the caller can warn the user when their
 * confirm turned out to destroy more than the empty/near-empty session they
 * thought they were looking at — e.g. a conversation minted in another pane
 * or tab committed between an earlier `last_conversation` 409 and this
 * confirm (caught in review: the advisory lock in `closeConversationInSession`
 * only serializes against OTHER closes, and no lock held for milliseconds
 * around either transaction can prevent a human confirming minutes later).
 */
export async function countOpenConversationsForSession(sessionId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(conversations)
    .where(and(eq(conversations.sessionId, sessionId), eq(conversations.isActive, true), isNull(conversations.closedInSessionAt)));
  return row?.n ?? 0;
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
    deps: { store, now: () => new Date(), maxActiveSessions: MAX_ACTIVE_SESSIONS_PER_OWNER },
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

/**
 * The conversations of MANY sessions in one query, grouped by session —
 * the collection GET's shape, which previously ran one query per session
 * (review M4: 1+2N per sidebar poll). Newest activity first per session,
 * capped at {@link MAX_SESSION_CONVERSATIONS} — the same ceiling
 * `planSpawnWorkerSession`/`createConversationInSessionWith` enforce, so a
 * session's own listing cap and its create-time cap agree by construction.
 *
 * The cap is enforced IN SQL via a `ROW_NUMBER() OVER (PARTITION BY
 * sessionId ...)` filter (issue #2262 finding 4), not the JS `bucket.length`
 * check the previous shape used: without a query-layer bound, a single
 * session holding far more rows than its cap pulled its ENTIRE row set into
 * app memory before the JS loop ever discarded the excess. The window
 * function is what keeps the per-session fairness a flat `LIMIT` would lose
 * — one hot session's rows cannot crowd another session's out of a shared cap
 * ordered across all of them together.
 *
 * DELIBERATE metadata exposure (issue #2262 finding 6): every caller with
 * access to a session (its owner, or any member whose own conversation lives
 * there) sees every OTHER conversation's title and agent in that session,
 * this way — including threads it did not create. Shared-workspace semantics,
 * not a leak: a session is one shared sandbox by design. TRANSCRIPT content
 * is a separate, still owner-gated read (`checkSessionAccess` /
 * `openOwnSession` in the tool layer) — this listing carries no message
 * bodies.
 */
export async function listSessionConversationsBulk(
  sessionIds: string[],
): Promise<Map<string, SessionConversationEntry[]>> {
  const grouped = new Map<string, SessionConversationEntry[]>();
  if (sessionIds.length === 0) return grouped;

  const rankedConversations = db
    .select({
      sessionId: conversations.sessionId,
      conversationId: conversations.id,
      title: conversations.title,
      type: conversations.type,
      contextId: conversations.contextId,
      lastMessageAt: conversations.lastMessageAt,
      rowNumber: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${conversations.sessionId} ORDER BY ${conversations.lastMessageAt} DESC)`.as(
        'row_number',
      ),
    })
    .from(conversations)
    .where(
      and(
        inArray(conversations.sessionId, sessionIds),
        eq(conversations.isActive, true),
        // Closed-from-the-session threads stay out of the listing — but their
        // HISTORY is untouched (isActive alone still gates that), so a
        // history-deleted thread stays excluded whichever column caused it.
        isNull(conversations.closedInSessionAt),
      ),
    )
    .as('ranked_conversations');

  const rows = await db
    .select({
      sessionId: rankedConversations.sessionId,
      conversationId: rankedConversations.conversationId,
      title: rankedConversations.title,
      type: rankedConversations.type,
      contextId: rankedConversations.contextId,
      lastMessageAt: rankedConversations.lastMessageAt,
    })
    .from(rankedConversations)
    .where(sql`${rankedConversations.rowNumber} <= ${MAX_SESSION_CONVERSATIONS}`);

  for (const row of rows) {
    if (row.sessionId === null) continue;
    const bucket = grouped.get(row.sessionId) ?? [];
    bucket.push({
      conversationId: row.conversationId,
      title: row.title,
      agentPageId: row.type === 'page' ? row.contextId : null,
      lastMessageAt: row.lastMessageAt,
    });
    grouped.set(row.sessionId, bucket);
  }
  return grouped;
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
  const [store, host, tenant] = await Promise.all([
    getAgentSessionStore(),
    getSandboxHost(),
    resolveSessionTenantId(row),
  ]);
  // Fail CLOSED on a vanished drive — never fall back to the session owner.
  // That fallback would fold the Sprite key under a DIFFERENT tenant than the
  // one this session's key already folded under on a prior provision,
  // splitting one session across two Sprite identities (audit #2265 finding 1).
  if (!tenant.ok) {
    return { ok: false, reason: 'provision_failed', detail: tenant.reason };
  }

  return ensureAgentSessionSandbox({
    row: { ...row, sessionId: row.id },
    intent: 'ensure',
    actor: { userId: requesterId, tenantId: tenant.tenantId },
    deps: {
      store,
      host,
      substrate: { kind: 'sprite' },
      options: resolveSandboxNetworkOptions({ surface: 'session', egressIpTag: getConfiguredEgressIpTag() }),
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
          // The generation just minted — the CAS target for the write. Taken
          // from the handle, not the row: this is the VM the `du` runs on.
          spriteInstanceId: handle.spriteInstanceId ?? null,
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
  /**
   * Returns the sandbox to measure AND its own generation id. Both, because the
   * two can disagree: this path is fed by a sandbox the tool run ALREADY
   * acquired, so by the time the row is read below the session may have been
   * torn down and re-provisioned — the row would say B while the handle in hand
   * is still A. CASing on the row's value would then let A's bytes land on B
   * under a CAS that "succeeded", which is the bug the CAS exists to stop.
   */
  attach: () => Promise<{ exec: SandboxHandle['exec']; spriteInstanceId: string | null } | null>;
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
      // The MEASURED handle's own generation, never the row's. The row is read
      // for the throttle; the CAS has to describe the disk the `du` actually
      // walked, or a handle captured before a re-provision would persist the
      // old generation's bytes under the new generation's id.
      spriteInstanceId: handle.spriteInstanceId,
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
