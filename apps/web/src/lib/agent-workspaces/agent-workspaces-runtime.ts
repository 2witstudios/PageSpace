/**
 * Production wiring for the agent-workspace services (`@pagespace/lib`
 * services/agent-workspaces) — DI of the DB-backed stores, the Sprites host, the
 * squat-guarded conversation creators, and the permission/capability lookups.
 *
 * ZERO decision logic lives here, by mandate: every `if` below turns a null
 * into another null (no page → no page permission to fetch; no drive → no
 * drive-scoped authorization input). Anything that WEIGHS these facts lives in
 * `packages/lib/src/agent-workspaces/` (the pure deciders/planners) and is
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
import { and, eq, inArray, sql } from '@pagespace/db/operators';
import { conversations } from '@pagespace/db/schema/conversations';
import { agentWorkspaceNodes } from '@pagespace/db/schema/agent-workspace-nodes';
import { users } from '@pagespace/db/schema/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
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
} from '@pagespace/lib/services/agent-workspaces/agent-workspaces';
import {
  createDbAgentSessionStore,
  type AgentSessionListFilter,
  type AgentSessionRecord,
  type AgentSessionStore,
} from '@pagespace/lib/services/agent-workspaces/agent-workspaces-store';
import {
  ensureAgentSessionSandbox,
  type EnsureAgentSessionSandboxResult,
} from '@pagespace/lib/services/agent-workspaces/agent-workspace-sprite';
import {
  checkAgentSessionAccess,
  checkAgentSessionEndAccess,
  type AgentSessionAccessCheck,
  type AgentSessionAccessDeps,
} from '@pagespace/lib/services/agent-workspaces/agent-workspace-access';
import {
  resolveSessionTenantId,
  resolveDriveMembership,
  canRunCodeForSession,
} from '@pagespace/lib/services/agent-workspaces/agent-workspace-tenant';
import { MAX_ACTIVE_WORKSPACES_PER_OWNER, type AgentSessionDTO } from '@pagespace/lib/agent-workspaces/session-contract';
import { decideAgentSessionAccess } from '@pagespace/lib/agent-workspaces/decide-workspace-access';
import { MAX_SESSION_CONVERSATIONS } from '@pagespace/lib/agent-workspaces/plan-spawn-worker';
import { planSessionReopen } from '@pagespace/lib/agent-workspaces/plan-workspace-lifecycle';
import { conversationRepository } from '@/lib/repositories/conversation-repository';
import { emitConversationLifecycle, type BumpedConversationRow } from '@/lib/repositories/conversation-rev';
import { resolveOrCreateConversation } from '@/lib/repositories/resolve-or-create-conversation';
import { countOpenConversations } from '@/lib/agent-workspaces/conversation-cap';
import { createConversationInSessionWith } from '@/lib/agent-workspaces/create-conversation-in-workspace';
import { conversationPageId } from '@pagespace/lib/conversations/conversation-page';
import { createId } from '@paralleldrive/cuid2';
import { admit, expel } from '@pagespace/lib/agent-workspaces/workspace-membership';
import { findWorkspaceOfChat } from '@pagespace/lib/services/agent-workspaces/workspace-membership-store';
import type { DbExecutor } from '@pagespace/lib/services/agent-workspaces/workspace-node-store';
import {
  applyWorkspaceMembershipWrite,
  destroyWorkspaceTree,
  type WithinNodeWrite,
} from '@/lib/agent-workspaces/workspace-node-runtime';
import {
  closeConversationInSessionWith,
  type CloseConversationOutcome,
} from '@/lib/agent-workspaces/close-conversation-in-workspace';
import {
  reopenConversationInSessionWith,
  type ReopenConversationOutcome,
} from '@/lib/agent-workspaces/reopen-conversation-in-workspace';
import {
  claimConversationInSessionWith,
  type AdmitConversationOutcome,
  type ClaimConversationOutcome,
  type ClaimConversationInSessionDeps,
} from '@/lib/agent-workspaces/claim-conversation-in-workspace';

export { isCodeExecutionEnabled };

/**
 * The most NOT-ENDED sessions one owner may hold. Spawn is deliberately
 * instant and free (no sandbox), which meant the live-sandbox concurrency
 * quota never applied to it — an authorized caller could mint unbounded rows
 * (review M6/F4). `spawnSession` below passes it as `spawnAgentSession`'s
 * REQUIRED `maxActiveSessions` dep (review #2261/2), and the route imports it
 * for its own advisory pre-check.
 *
 * A RE-EXPORT of the one contract constant, not a second number: the store's
 * listing LIMIT is the same `MAX_ACTIVE_WORKSPACES_PER_OWNER`, which is what
 * makes "a listing never truncates an owner's real set" structural rather
 * than a two-constants-kept-equal-by-hand invariant (epic Phase 1, D7).
 */
export { MAX_ACTIVE_WORKSPACES_PER_OWNER as MAX_ACTIVE_SESSIONS_PER_OWNER } from '@pagespace/lib/agent-workspaces/session-contract';

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

export async function findSessionRecord(workspaceId: string): Promise<AgentSessionRecord | null> {
  return (await getAgentSessionStore()).findById(workspaceId);
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

function buildAccessDeps(): AgentSessionAccessDeps {
  return {
    findSession: async (workspaceId) => {
      const row = await findSessionRecord(workspaceId);
      if (!row) return null;
      return { ownerId: row.ownerId, driveId: row.driveId };
    },
    resolveDriveMembership,
    canRunCode: canRunCodeForSession,
  };
}

export async function checkSessionAccess(
  requesterId: string,
  workspaceId: string,
): Promise<AgentSessionAccessCheck> {
  return checkAgentSessionAccess({ requesterId, workspaceId, deps: buildAccessDeps() });
}

/**
 * The same ONE pure decision, applied BEFORE a row exists — the spawn path's
 * subject is the session about to be minted (`ownerId` = the requester,
 * `driveId` = where it will live; there is no id yet, and the decision never
 * needs one). This gathers the identical facts `buildAccessDeps` gathers and
 * hands them to `decideAgentSessionAccess`; no extra rule exists here.
 */
export async function checkAccessForSubject(
  requesterId: string,
  subject: { ownerId: string; driveId: string | null },
): Promise<AgentSessionAccessCheck> {
  const deps = buildAccessDeps();
  const driveMembership =
    subject.driveId === null
      ? null
      : await deps.resolveDriveMembership({ userId: requesterId, driveId: subject.driveId });
  return decideAgentSessionAccess({
    requesterId,
    session: subject,
    driveMembership,
  });
}

export async function checkSessionEndAccess(
  requesterId: string,
  workspaceId: string,
): Promise<AgentSessionAccessCheck> {
  return checkAgentSessionEndAccess({
    requesterId,
    workspaceId,
    deps: buildAccessDeps(),
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/*
 * `withSessionListingLock` USED TO BE HERE, with its retry budget, its
 * `SessionListingLockBusyError`, and its dedicated-connection advisory lock.
 *
 * It existed to serialize every operation that consumed or freed a workspace's
 * open-listing slot — create, close, reopen, and the History delete's
 * never-empty guard — because the cap was a `SELECT count(*)` over
 * `conversations` and the write it guarded was a different statement on a
 * different row. Four call sites each had to remember to take it, and it had to
 * live on a SEPARATE POOL to avoid deadlocking against the very queries it was
 * protecting (`db.ts`'s `getAdvisoryLockPool` warns about exactly that hazard).
 *
 * Membership is one table now, and the cap is a count over the tree inside the
 * transaction that writes the tree — so the serialization is the lock that
 * write already takes (`withWorkspaceLock`, per workspace, in the
 * transaction). One lock for one invariant, and no call site can forget it
 * because there is no call site: it is inside the funnel.
 */

/**
 * THE MEMBERSHIP WRITE, wired.
 *
 * Every path that puts a conversation into a workspace — a fresh mint, a claim
 * of an existing thread, a worker an agent spawned — lands here, and here is one
 * call: `admit` decided against the tree, persisted by
 * `applyWorkspaceMembershipWrite` inside the workspace's own locked
 * transaction. `conversations.workspaceId` is no longer written by anything.
 *
 * `within` is the transaction's other half — the conversation row itself, on
 * the create path. Passing it through rather than running it beside this call
 * is what makes a thread and its membership one commit.
 */
async function admitConversationNode(input: {
  conversationId: string;
  workspaceId: string;
  /** The acting HUMAN, for the binding gate inside the write. */
  actingUserId: string;
  excludeTargetId?: string;
  within?: WithinNodeWrite;
}): Promise<AdmitConversationOutcome> {
  const result = await applyWorkspaceMembershipWrite({
    workspaceId: input.workspaceId,
    actingUserId: input.actingUserId,
    run: (nodes) =>
      admit(nodes, {
        target: { kind: 'chat', id: input.conversationId },
        // Server-minted, unlike every other id in this model: there is no
        // client here to author one, and nothing is applying this write
        // optimistically.
        newNodeId: createId(),
        newSplitId: createId(),
        newRootId: createId(),
        ...(input.excludeTargetId === undefined ? {} : { excludeTargetId: input.excludeTargetId }),
      }),
    ...(input.within === undefined ? {} : { within: input.within }),
  });

  if (result.status === 'refused') {
    if (result.code === 'session_full') return 'session_full';
    if (result.code === 'bound_elsewhere') return 'bound_elsewhere';
    return 'refused';
  }
  // Unreachable: a membership write's `baseRev` IS the rev the lock read.
  // Named rather than folded in, so a `stale` appearing here reads as "the
  // funnel stopped deciding under the lock", which is a bug.
  if (result.status === 'stale') return 'refused';
  // The chat-target index refused it: the conversation is bound to a node in
  // another workspace. Answered as the refusal it is rather than folded into
  // `refused`, because a caller can act on the difference.
  if (result.status === 'conflict') return 'bound_elsewhere';

  if (!result.changed) return 'already_a_member';

  // New work landing in an ENDED workspace reopens its listing — the ONE hook
  // every admission shares (worker spawns, the HTTP claim route, the global
  // auto-bind), so a workspace can never hold fresh work while hidden from the
  // sidebar (issue #2335). Best-effort by design: the membership already
  // committed above, so a reopen failure must never surface as a creation
  // failure — the caller would treat an already-admitted conversation as
  // unavailable and retry into a `SessionFullError` on its own successful bind
  // (review finding — coderabbitai, PR #2336).
  await reopenEndedSessionListing(input.workspaceId).catch((error) => {
    loggers.api.warn('Failed to reopen ended session listing after a successful admission', {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return 'admitted';
}

/**
 * The membership deps every path into a workspace shares.
 *
 * `countActiveConversations` is gone from this surface entirely, and its
 * absence is the point: the cap is decided by `admit` against the tree it is
 * about to write, inside one locked transaction, so there is no longer a count
 * that could be read here and acted on a moment later.
 */
function buildClaimDeps(actingUserId: string): ClaimConversationInSessionDeps<DbExecutor> {
  return {
    findConversation: async (conversationId) => {
      const row = await conversationRepository.getConversation(conversationId);
      if (!row) return null;
      return {
        userId: row.userId,
        type: row.type,
        contextId: row.contextId,
        isActive: row.isActive,
      };
    },
    // MEMBERSHIP, from the tree. One lookup on the global chat-target index —
    // the successor to reading `conversations.workspaceId`.
    findWorkspaceOfConversation: (conversationId) => findWorkspaceOfChat(db, conversationId),
    findAgentDriveId: async (agentPageId) => {
      const agent = await conversationRepository.getAiAgent(agentPageId);
      return agent?.driveId ?? null;
    },
    findSession: async (workspaceId) => {
      const row = await findSessionRecord(workspaceId);
      return row ? { driveId: row.driveId, endedAt: row.endedAt } : null;
    },
    admitConversation: (input) => admitConversationNode({ ...input, actingUserId }),
  };
}

/**
 * WHICH WORKSPACE HOLDS THIS THREAD — the membership read, and the successor to
 * every `conversations.workspaceId` lookup in the app.
 *
 * One row on the node table's global chat-target index, which is UNIQUE: "a
 * thread has one workspace" is the database's rule now rather than a column two
 * writers could disagree about.
 */
export async function findWorkspaceOfConversation(conversationId: string): Promise<string | null> {
  return findWorkspaceOfChat(db, conversationId);
}

/**
 * Withdraw a session's end-intent (`planSessionReopen` — `endedAt` only, the
 * confirmed-kill stamp stays; see its doc for why) when new work is admitted
 * into it. CAS-guarded on the `endedAt` this read observed, so a concurrent
 * re-end is never silently erased.
 */
async function reopenEndedSessionListing(workspaceId: string): Promise<void> {
  const store = await getAgentSessionStore();
  const row = await store.findById(workspaceId);
  if (!row || row.endedAt === null) return;
  await store.applyStamps({
    workspaceId,
    stamps: planSessionReopen(),
    cas: { endedAt: row.endedAt },
  });
}

/**
 * Claim a NEVER-BOUND conversation into a workspace — the wiring for
 * `claim-conversation-in-workspace.ts`'s pure decision.
 *
 * No `withSessionListingLock` any more, and that is not an omission. That lock
 * existed to serialize the cap's count-then-write against other creates and
 * closes; the count now happens inside `withWorkspaceLock`'s transaction,
 * against the tree the same transaction writes, so the serialization is the
 * lock the write already takes. Two locks for one invariant was the shape that
 * let a node write and a membership write touch one workspace at once.
 */
export async function claimConversationInSession(input: {
  conversationId: string;
  userId: string;
  workspaceId: string;
}): Promise<ClaimConversationOutcome> {
  return claimConversationInSessionWith(buildClaimDeps(input.userId), input);
}

/**
 * Create a conversation and make it a member of a workspace, atomically.
 * Decision logic lives in the pure module
 * (`create-conversation-in-workspace.ts`) — this is only its production wiring.
 *
 * The two creators are handed the TRANSACTION the node write runs in, which is
 * the whole of this leaf: a conversation row and the node that makes it a
 * member commit together or not at all. `resolveOrCreateConversation` and
 * `conversationRepository.createConversation` both already took an optional
 * executor for exactly this kind of caller; what is new is that this one
 * supplies it.
 *
 * Throws `ConversationUnavailableError` (message `conversation_unavailable`)
 * when the id cannot be admitted with this binding — foreign owner, legacy
 * message-owner conflict, an existing row whose anchor disagrees, or a thread
 * the chat-target index says already has a home.
 */
export async function createConversationInSession(input: {
  conversationId: string;
  userId: string;
  /** null = a global-assistant conversation. */
  agentPageId: string | null;
  workspaceId: string;
  /** Display label written at birth (a spawned worker's name). */
  title?: string | null;
  /**
   * The spawning conversation, when it shares this grid — never evicted by its
   * own spawn. Only `spawn_session` has one.
   */
  excludeTargetId?: string;
}): Promise<void> {
  await createConversationInSessionWith<DbExecutor>(
    {
      ...buildClaimDeps(input.userId),
      createPageConversation: ({ conversationId, userId, agentPageId, title }, tx) =>
        conversationRepository.createConversation(conversationId, userId, agentPageId, {
          title: title ?? undefined,
          executor: tx,
        }),
      createGlobalConversation: async ({ conversationId, userId, title }, tx) => {
        await resolveOrCreateConversation(userId, conversationId, tx, {
          title: title ?? undefined,
        });
      },
      findConversationIn: async (conversationId, tx) => {
        const [row] = await tx
          .select({
            userId: conversations.userId,
            type: conversations.type,
            contextId: conversations.contextId,
          })
          .from(conversations)
          .where(eq(conversations.id, conversationId))
          .limit(1);
        return row ?? null;
      },
    },
    input,
  );
}

/**
 * The row facts the close/reopen decisions weigh — OWNERSHIP and HISTORY, and
 * nothing else.
 *
 * `workspaceId` and `closedInWorkspaceAt` are gone from this read because they
 * are gone from the decisions: "is this thread in this workspace" and "is it on
 * screen" are both answered by the membership write, from the tree, under the
 * lock. A pre-read of either would be a fact that could go stale between the
 * check and the act, which is what the two-structure model was made of.
 */
function conversationOwnerRead() {
  return {
    findConversation: async (conversationId: string): Promise<BumpedConversationRow | null> => {
      const [row] = await db
        .select({
          // The workspace check their routes run is drive-membership-wide and
          // does NOT answer "is this conversation the caller's".
          userId: conversations.userId,
          isActive: conversations.isActive,
          // THE REST IS THE EMIT CONTEXT, read here rather than in a second
          // query after the write. Close and reopen change no `conversations`
          // column — membership is a node — so there is no `RETURNING` to carry
          // these facts the way every other lifecycle write's bump does. This
          // read already runs on both paths for the ownership gate; widening
          // its projection is free where a second SELECT would not be.
          //
          // The rev is passed through UNBUMPED, deliberately. It is the MESSAGE
          // plane's watermark, and a membership change writes no message: a
          // bump here would make every subscribed pane detect a gap and refetch
          // a transcript that did not change. The directory listener never
          // consults it.
          id: conversations.id,
          rev: conversations.rev,
          isShared: conversations.isShared,
          type: conversations.type,
          contextId: conversations.contextId,
          title: conversations.title,
          lastMessageAt: conversations.lastMessageAt,
          createdAt: conversations.createdAt,
        })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);
      return row ? { ...row, rev: Number(row.rev) } : null;
    },
  };
}

/**
 * Close a conversation off its workspace's grid — the wiring for
 * `close-conversation-in-workspace.ts`'s pure decision. A `move` to no parent,
 * inside the workspace's own locked transaction, so it serializes against every
 * other write to that tree rather than against a second lock that only close
 * and reopen ever took.
 */
export async function closeConversationInSession(input: {
  conversationId: string;
  /** The CALLER. The pure decision refuses a conversation this user does not own. */
  userId: string;
  workspaceId: string;
}): Promise<CloseConversationOutcome> {
  return closeConversationInSessionWith(
    {
      ...conversationOwnerRead(),
      dismissConversation: async ({ conversationId, workspaceId }) => {
        const result = await applyWorkspaceMembershipWrite({
          workspaceId,
          actingUserId: input.userId,
          run: (nodes) => expel(nodes, { target: { kind: 'chat', id: conversationId } }),
        });
        if (result.status === 'refused') {
          return result.code === 'not_a_member' ? 'not_a_member' : 'refused';
        }
        if (result.status === 'stale') return 'refused';
        return 'dismissed';
      },
      // The directory plane. See `announceClosed`'s own doc for why the node
      // write's `workspace:nodes-updated` does not cover this: that event
      // carries the TREE, and the sidebar's rows come from the LISTING.
      announceClosed: (row) => emitConversationLifecycle('closed', row),
    },
    input,
  );
}

/**
 * Put a conversation back on its workspace's grid — the wiring for
 * `reopen-conversation-in-workspace.ts`'s pure decision. The same lock and the
 * same transaction the close takes, so a reopen can never race a close, or
 * another reopen, or a drag.
 */
export async function reopenConversationInSession(input: {
  conversationId: string;
  /** The CALLER. The pure decision refuses a conversation this user does not own. */
  userId: string;
  workspaceId: string;
}): Promise<ReopenConversationOutcome> {
  return reopenConversationInSessionWith(
    {
      ...conversationOwnerRead(),
      // REOPENING IS RE-ADMITTING. There is no `readmit` any more: it was a
      // `move` back onto the grid, and it existed only because a closed thread
      // kept a node with no parent. Closing DESTROYS that node, so a thread that
      // was closed is a member of nothing and putting it back is an ordinary
      // admission — which is also what re-consults the cap it stopped occupying.
      readmitConversation: async ({ conversationId, workspaceId }) => {
        const result = await admitConversationNode({
          conversationId,
          workspaceId,
          actingUserId: input.userId,
        });
        switch (result) {
          case 'admitted':
            return 'readmitted';
          case 'already_a_member':
            return 'already_attached';
          case 'session_full':
          case 'bound_elsewhere':
          case 'refused':
            return 'refused';
        }
      },
      announceReopened: (row) => emitConversationLifecycle('reopened', row),
    },
    input,
  );
}

/** What a history-delete's membership half came to. */
export type ExpelConversationOutcome = 'expelled' | 'refused';

/**
 * Remove a conversation from its workspace ENTIRELY — history-deletion's
 * membership half.
 *
 * A thread whose history is gone has no listing to keep and no pane to render:
 * leaving its node behind would leave a rectangle bound to nothing and a cap
 * slot nobody could reclaim.
 *
 * **The never-empty guard is gone**, and with it the `last_conversation` answer
 * this function used to be able to give. `requireSurvivor` refused to take a
 * workspace's last conversation, upholding "a workspace is never empty" — an
 * invariant that only had teeth while a two-level grid could not represent zero
 * panes and while "the last one closed" was the inference that ended a session.
 * An empty tree is an ordinary resting state now, and a session ends when
 * someone destroys its root. A guard defending a state nobody can reach only
 * ever fires on legitimate work: here, on deleting the history of the one thread
 * a workspace happened to be left with.
 *
 * `not_a_member` reads as SUCCESS. The removal is addressed by target and
 * refuses a thread the workspace does not hold, because a caller acting for a
 * user is owed the truth — this caller is not one of those. It runs behind a
 * deletion that has already been authorized, and "it was not there" is the state
 * that deletion asked for.
 *
 * **Call this BEFORE the soft-delete, not inside its transaction.** The two
 * writes cannot be made one without threading an executor through
 * `softDeleteConversation`'s message deactivation, room kicks and emits — so
 * instead the ORDER is chosen so the survivable failure is the one that can
 * happen. Expel-then-delete can leave a thread with intact history that is no
 * longer in a workspace, which a re-claim fixes. Delete-then-expel would leave a
 * pane bound to a dead thread and a cap slot nobody can reclaim, which is the
 * ghost this epic deletes, pointing the other way.
 */
export async function expelConversationFromSession(input: {
  conversationId: string;
  workspaceId: string;
  actingUserId: string;
}): Promise<ExpelConversationOutcome> {
  const result = await applyWorkspaceMembershipWrite({
    workspaceId: input.workspaceId,
    actingUserId: input.actingUserId,
    run: (nodes) => expel(nodes, { target: { kind: 'chat', id: input.conversationId } }),
  });
  if (result.status === 'ok') return 'expelled';
  if (result.status === 'refused' && result.code === 'not_a_member') return 'expelled';
  loggers.api.error('History delete could not remove the thread from its workspace', undefined, {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    reason: result.status === 'refused' ? result.code : result.status,
  });
  return 'refused';
}

/**
 * A plain, lock-free, INFORMATIONAL read — not a guard. Ending a session is a
 * genuinely unconditional act (the sidebar's own "End session" is reachable
 * with any number of conversations, by design), so this never blocks
 * `endSession`; it exists only so the caller can warn the user when their
 * confirm turned out to destroy more than the empty/near-empty session they
 * thought they were looking at.
 *
 * It counts MEMBERS now — every thread the workspace holds, on screen or
 * parked — because that is what ending the session actually destroys. Under the
 * column it counted "open listings", which was a different set from the one the
 * grid drew and a different set again from the one the delete would take.
 */
export async function countOpenConversationsForSession(workspaceId: string): Promise<number> {
  return countOpenConversations(workspaceId);
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
    deps: { store, now: () => new Date(), maxActiveSessions: MAX_ACTIVE_WORKSPACES_PER_OWNER },
  });
}

/** Resolve a conversation's session — how a chat turn finds its working context. Null = a plain chat. */
export async function findSessionForConversation(conversationId: string): Promise<AgentSessionRecord | null> {
  return (await getAgentSessionStore()).findByConversation(conversationId);
}

/**
 * Every one of these is racy or retryable by nature (a session cap another
 * concurrent call may have just filled, a transient spawn fault, a lost
 * claim) — never a deterministic "this conversation can never have a
 * session." Callers that gate on this (billing) must treat the whole set
 * the same way, not narrow to whichever specific reason the last bug was
 * about (two separate reviewer findings on PR #2314 were each a caller
 * treating one of these as safely equivalent to "no session, ever").
 */
export type EnsureGlobalSandboxSessionFailureReason = 'session_limit_reached' | 'spawn_failed' | 'no_session';

export type EnsureGlobalSandboxSessionResult =
  | { ok: true; session: AgentSessionRecord }
  | { ok: false; reason: EnsureGlobalSandboxSessionFailureReason };

/**
 * Auto-provision a workspace for a Global Assistant conversation that has
 * never had one — the exact same primitive a manual "New session → Global
 * Assistant" spawn uses (spawn, then claim), just triggered from the first
 * sandbox or session tool call instead of the command palette. The caller
 * (`sandbox-tools-runtime.ts` / `session-tools-runtime.ts`) is the one that
 * decides WHEN minting is appropriate and has checked the actor may spawn
 * there; this function only knows how to mint and bind.
 */
export async function ensureGlobalSandboxSession(
  conversationId: string,
  userId: string,
): Promise<EnsureGlobalSandboxSessionResult> {
  return ensureConversationSession(conversationId, userId, null);
}

/**
 * The drive-scoped twin of `ensureGlobalSandboxSession` — same spawn+claim
 * body, the session lives in `driveId` (a page agent's drive). Callers MUST
 * have already authorized the mint (`checkAccessForSubject` on the drive plus
 * the agent view check) — this is mechanism, not policy, exactly like the
 * global variant.
 */
export async function ensureDriveSessionForConversation(
  conversationId: string,
  userId: string,
  driveId: string,
): Promise<EnsureGlobalSandboxSessionResult> {
  return ensureConversationSession(conversationId, userId, driveId);
}

async function ensureConversationSession(
  conversationId: string,
  userId: string,
  driveId: string | null,
): Promise<EnsureGlobalSandboxSessionResult> {
  const spawned = await spawnSession({ userId, driveId });
  if (!spawned.ok) {
    // `session_limit_reached` is a distinct, actionable denial ("end an
    // existing session first") the caller already knows how to surface —
    // collapsing it into the generic no_session message would tell an agent
    // sitting at its owner's session cap to do something that can't help
    // ("start a new conversation").
    return { ok: false, reason: spawned.reason === 'session_limit_reached' ? 'session_limit_reached' : 'spawn_failed' };
  }

  // Cleanup shared by both the "claim lost" and "claim threw" paths below —
  // the freshly spawned session would otherwise sit empty forever, which the
  // session model treats as an invariant violation (mirrors the same cleanup
  // the spawn route itself does when its own first-conversation creation
  // fails). Fail-open (never lets a cleanup fault surface as THIS call's own
  // error) but logged — a silently swallowed failure here would leave the
  // scratch session live, counting against MAX_ACTIVE_SESSIONS_PER_OWNER and
  // accruing cost, with no signal anywhere (review finding — CodeRabbit).
  const endScratchSession = (cause: string) =>
    endSession(spawned.session.id).catch((error) => {
      loggers.api.warn(`Failed to end scratch session after ${cause}`, {
        workspaceId: spawned.session.id,
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

  let claimed: ClaimConversationOutcome;
  try {
    claimed = await claimConversationInSession({
      conversationId,
      userId,
      workspaceId: spawned.session.id,
    });
  } catch (error) {
    // `claimConversationInSession` can THROW (the advisory lock exhausting
    // its retries, a DB connection fault) rather than resolving a normal
    // outcome — a path that skipped this cleanup entirely before, leaking
    // the scratch session on every such failure (review finding —
    // chatgpt-codex-connector).
    //
    // The thrown error is AMBIGUOUS in a way `claimed === 'not_found'` below
    // never is: the guarded UPDATE may have actually COMMITTED server-side
    // with the connection dropping before this call ever saw the
    // acknowledgment. Ending our scratch session on that outcome would be
    // catastrophic, not just wasteful — bindings are write-once, so a
    // conversation left pointing at a session we just ENDED can never be
    // re-claimed into a replacement, ever (review finding, second pass —
    // chatgpt-codex-connector). Re-resolve BEFORE tearing anything down: if
    // the conversation is now bound to the session we spawned, the claim
    // genuinely succeeded despite the thrown error — treat it as one.
    //
    // A single autocommit UPDATE's commit is durable and immediately visible
    // to any other connection the instant it completes server-side — there
    // is no PostgreSQL window where a commit has finished but the write is
    // not yet visible elsewhere, and a connection that drops before that
    // point aborts the (never-committed) statement outright. So one re-read
    // is already conclusive under normal Postgres semantics. The brief
    // retry below is pure defense-in-depth against exactly that claim being
    // wrong in some deployment-specific way (a pooler, a replica read) that
    // isn't visible from this file alone — cheap insurance given how
    // unrecoverable a wrong "unclaimed" verdict is here (review finding,
    // third pass — chatgpt-codex-connector).
    //
    // These re-reads are themselves NOT exception-safe by default: the same
    // DB/connection fault that made the claim throw is plausibly still in
    // effect. Distinguish "verification SUCCEEDED and found nothing" (safe
    // to end — we have a real, current answer) from "verification itself
    // FAILED" (unknown — treating that the same as "confirmed unclaimed"
    // would let a compound failure (claim commits + verification ALSO
    // fails) still end a session the conversation is genuinely bound to,
    // reopening the exact stranding this whole catch block exists to
    // prevent). On a failed verification, this leaves the scratch session
    // alone rather than gambling on it — a stray, un-ended, sandbox-less
    // session is a cheap, fully recoverable cost (visible in the sidebar,
    // endable by hand); permanently stranding a conversation on a dead one
    // is not (review findings — CodeRabbit and chatgpt-codex-connector,
    // both independently, then a further round from chatgpt-codex-connector
    // on the compound-failure case).
    let boundAfterThrow: AgentSessionRecord | null = null;
    let verificationFailed = false;
    try {
      boundAfterThrow = await findSessionForConversation(conversationId);
      if (!boundAfterThrow) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        boundAfterThrow = await findSessionForConversation(conversationId);
      }
    } catch (lookupError) {
      verificationFailed = true;
      loggers.api.warn('Failed to re-resolve conversation binding after a claim exception', {
        workspaceId: spawned.session.id,
        conversationId,
        error: lookupError instanceof Error ? lookupError.message : String(lookupError),
      });
    }
    if (boundAfterThrow?.id === spawned.session.id) {
      return { ok: true, session: spawned.session };
    }
    if (verificationFailed) {
      throw error;
    }
    // Verification SUCCEEDED and confirmed we are NOT bound to it — either
    // truly unclaimed, or a concurrent sibling's claim won in the meantime.
    // Either way our scratch session is safe to tear down; adopt the
    // sibling's session if one is there, otherwise this really is the infra
    // fault it looked like — propagate it.
    await endScratchSession('a claim exception');
    if (boundAfterThrow) return { ok: true, session: boundAfterThrow };
    throw error;
  }
  if (claimed === 'claimed' || claimed === 'already_in_session') return { ok: true, session: spawned.session };

  // The claim lost a race — most likely a CONCURRENT call for the same
  // conversation (two sandbox tool calls in one turn, two tabs) won first
  // and bound it to the session IT spawned. That winner's session is
  // exactly as valid as the one this call would have minted, so re-resolve
  // through the conversation rather than failing outright — otherwise the
  // losing call would spuriously deny a conversation that, by the time this
  // line runs, genuinely has a session. Only a conversation deleted out
  // from under both calls resolves to nothing here.
  await endScratchSession('a lost conversation claim');
  const winner = await findSessionForConversation(conversationId);
  return winner ? { ok: true, session: winner } : { ok: false, reason: 'no_session' };
}

export interface SessionConversationEntry {
  conversationId: string;
  title: string | null;
  /** The thread's agent page (`contextId` for a page chat), or null for a global-assistant thread. */
  agentPageId: string | null;
  lastMessageAt: Date | null;
  /**
   * The thread's own owner (`conversations.userId`) and deliberate-share flag
   * (`conversations.isShared`) — the two facts the shared-workspace title
   * redaction rule weighs (`redact-conversation-listing.ts` in
   * `@pagespace/lib`; see this function's doc below). Derived at read from
   * the same row, never a second copy.
   */
  ownerId: string;
  isShared: boolean;
  /**
   * The NODE that makes this thread a member — its address in the workspace's
   * tree, and the successor to the `pane.paneId` the deleted annotation used to
   * bolt on. Always present: without a node there is no membership, so there is
   * no listing entry to carry one.
   */
  nodeId: string;
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
 * workspaceId ...)` filter (issue #2262 finding 4), not the JS `bucket.length`
 * check the previous shape used: without a query-layer bound, a single
 * session holding far more rows than its cap pulled its ENTIRE row set into
 * app memory before the JS loop ever discarded the excess. The window
 * function is what keeps the per-session fairness a flat `LIMIT` would lose
 * — one hot session's rows cannot crowd another session's out of a shared cap
 * ordered across all of them together.
 *
 * Metadata exposure (issue #2262 finding 6) — the rule, decided where the
 * queries live: the SESSION'S OWNER sees every conversation's title in their
 * own session (shared-workspace semantics — one shared sandbox by design).
 * A viewer who does NOT own the session sees a title only for threads that
 * are their own or deliberately shared (`conversations.isShared`); every
 * other row survives with its agent and activity time but its title replaced
 * by the fixed `(private thread)` marker. The mechanism is ONE pure function
 * — `redactConversationTitleForViewer`
 * (`@pagespace/lib/agent-workspaces/redact-conversation-listing`) — which every
 * viewer-facing mapping of these rows must route titles through (today: the
 * session-tool listings in `session-tools-runtime.ts`; the sidebar/API
 * surfaces only ever enumerate the caller's OWN sessions, where the owner
 * rule makes redaction a no-op). This entry therefore carries `ownerId` and
 * `isShared` so mapping layers can apply the rule without a second query.
 * TRANSCRIPT content is a separate, still owner-gated read
 * (`checkSessionAccess` / `openOwnSession` in the tool layer) — this listing
 * carries no message bodies.
 */
export async function listSessionConversationsBulk(
  workspaceIds: string[],
): Promise<Map<string, SessionConversationEntry[]>> {
  const grouped = new Map<string, SessionConversationEntry[]>();
  if (workspaceIds.length === 0) return grouped;

  // MEMBERSHIP IS THE JOIN. `conversations.workspaceId` used to select these
  // rows and `closedInWorkspaceAt` used to filter them; both are gone, and the
  // node that binds the thread does the whole job. There is nothing left for
  // `annotateConversationsWithPanes` to reconcile, which is why that module and
  // its suite are deleted rather than ported.
  //
  // It used to select `parentId IS NOT NULL AS attached` beside each row, so a
  // caller could tell a thread on screen from one parked. There is one place a
  // node can be, so presence in this list IS "on screen" and the column has
  // nothing left to report.
  const rankedConversations = db
    .select({
      workspaceId: agentWorkspaceNodes.rootId,
      // EXPLICITLY ALIASED, both of them. Drizzle names a subquery's output
      // columns after the SOURCE column, so `agent_workspace_nodes.id` and
      // `conversations.id` both came out as `"id"` and the outer select's
      // `"id"` was `column reference "id" is ambiguous` (42702) — this listing
      // failed outright for every caller. It went unnoticed because the suite
      // that covers it is DB-backed and the shared test database had been
      // wiped, so it skipped rather than ran.
      nodeId: sql<string>`${agentWorkspaceNodes.id}`.as('node_id'),
      conversationId: sql<string>`${conversations.id}`.as('conversation_id'),
      title: conversations.title,
      type: conversations.type,
      contextId: conversations.contextId,
      lastMessageAt: conversations.lastMessageAt,
      ownerId: conversations.userId,
      isShared: conversations.isShared,
      rowNumber: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${agentWorkspaceNodes.rootId} ORDER BY ${conversations.lastMessageAt} DESC)`.as(
        'row_number',
      ),
    })
    .from(agentWorkspaceNodes)
    .innerJoin(conversations, eq(conversations.id, agentWorkspaceNodes.targetId))
    .where(
      and(
        inArray(agentWorkspaceNodes.rootId, workspaceIds),
        eq(agentWorkspaceNodes.targetKind, 'chat'),
        // HISTORY, and only history. A history-deleted thread is excluded
        // because its transcript is gone, which is a different fact from where
        // its node sits — and the reason `expelConversationFromSession` removes
        // the node too, so this filter is a belt against a row the delete could
        // not reach rather than the listing's real membership rule.
        eq(conversations.isActive, true),
      ),
    )
    .as('ranked_conversations');

  const rows = await db
    .select({
      workspaceId: rankedConversations.workspaceId,
      nodeId: rankedConversations.nodeId,
      conversationId: rankedConversations.conversationId,
      title: rankedConversations.title,
      type: rankedConversations.type,
      contextId: rankedConversations.contextId,
      lastMessageAt: rankedConversations.lastMessageAt,
      ownerId: rankedConversations.ownerId,
      isShared: rankedConversations.isShared,
    })
    .from(rankedConversations)
    .where(sql`${rankedConversations.rowNumber} <= ${MAX_SESSION_CONVERSATIONS}`);

  for (const row of rows) {
    const bucket = grouped.get(row.workspaceId) ?? [];
    bucket.push({
      conversationId: row.conversationId,
      title: row.title,
      agentPageId: conversationPageId(row),
      lastMessageAt: row.lastMessageAt,
      ownerId: row.ownerId,
      isShared: row.isShared,
      nodeId: row.nodeId,
    });
    grouped.set(row.workspaceId, bucket);
  }
  return grouped;
}

/**
 * Provision (or resume/adopt) a session row's sandbox — the ONE code path both
 * the web app and the realtime bridge use, per `agent-workspace-sprite.ts`'s CAS
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
    row: { ...row, workspaceId: row.id },
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
        // Tier of the PAYER — the drive's owner, already resolved as the
        // session's tenant above (drive owner, else session owner) — not the
        // session creator's own tier (review #2326): a free-tier member's
        // session in a Pro-owned drive is paid for, and therefore
        // tier-entitled, by the drive owner. The ceiling still COUNTS the
        // session owner's live sessions (`ownerId`), keeping per-owner
        // accounting separate from payer-based entitlement.
        const payer = await db.query.users.findFirst({
          where: eq(users.id, tenant.tenantId),
          columns: { subscriptionTier: true },
        });
        return checkAgentSessionConcurrency({
          ownerId,
          tier: toSubscriptionTier(payer?.subscriptionTier),
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
      measureSessionStorage: async ({ workspaceId, handle }) => {
        await refreshSessionStorageMeasurement({
          handle,
          workspaceId,
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
  workspaceId: string;
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
    const row = await store.findById(input.workspaceId);
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
      workspaceId: input.workspaceId,
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

/**
 * END A SESSION: settle the row's lifecycle, then `destroy(rootId)`.
 *
 * **The tree operation is the removal, and it is the SAME removal that closes a
 * pane** — see `destroyWorkspaceTree`. What this function adds is the lifecycle
 * consequence a pane destroy does not have: a session owns a sandbox, an
 * `endedAt` and a billing history, and none of that is a fact about a node.
 *
 * **THE ORDER IS LOAD-BEARING, and it is lifecycle first.** The two writes are
 * deliberately not one transaction (a Sprite is outside the database; see
 * `destroyWorkspaceTree` for the full argument), so what matters is which
 * interrupted state is survivable:
 *
 *  - **Lifecycle, then tree** — a crash in between leaves an ended row and a
 *    tree that outlived it. Visible, harmless, and cleared by re-issuing the
 *    DELETE: `endAgentSession` answers `already_ended` as a no-op and the
 *    destroy then runs. Nothing is billing that nobody is watching, because
 *    `endAgentSession`'s FIRST durable write is `teardownRequestedAt` — from
 *    that instant the orphan reconciler owns the VM.
 *  - **Tree, then lifecycle** — a crash in between leaves the tree gone, the row
 *    un-stamped, and the Sprite alive with NO teardown request against it. The
 *    reconciler will not touch it (an explicit recorded intent is what licenses
 *    it to destroy anything), so it bills until a human notices. That is the one
 *    failure here that costs money and that no background process can see.
 *
 * The tree write is best-effort ON PURPOSE: the session is ended once the row
 * says so, and reporting a teardown failure because some layout rows outlived it
 * would tell the caller the compute is still running when it is not.
 */
export async function endSession(workspaceId: string): Promise<EndAgentSessionResult> {
  const [store, host] = await Promise.all([getAgentSessionStore(), getSandboxHost()]);
  const row = await store.findById(workspaceId);
  const ended = await endAgentSession({ workspaceId, deps: { store, host, now: () => new Date() } });
  if (!ended.ok) return ended;

  // The acting user is the workspace's OWNER: this write binds nothing, so the
  // gate has nothing to judge, and the owner is the identity the row itself
  // carries rather than one this call would have to be told.
  const ownerId = row?.ownerId;
  if (ownerId !== undefined) {
    const destroyed = await destroyWorkspaceTree({ workspaceId, actingUserId: ownerId });
    if (destroyed.status !== 'ok') {
      loggers.api.error('Session ended but its tree was not destroyed; re-issuing the end will clear it', undefined, {
        workspaceId,
        status: destroyed.status,
        ...(destroyed.status === 'refused' ? { code: destroyed.code } : {}),
      });
    }
  }
  return ended;
}

export async function listSessions(filter: AgentSessionListFilter): Promise<AgentSessionDTO[]> {
  const store = await getAgentSessionStore();
  return listAgentSessions({ filter, deps: { store } });
}

export { toAgentSessionDTO };
export type { AgentSessionRecord, AgentSessionListFilter };
