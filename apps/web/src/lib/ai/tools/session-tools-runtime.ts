/**
 * Production wiring for the session + shell tool families.
 *
 * Binds `createSessionTools` to: the agent-sessions runtime (the SAME
 * ensure/provision/end path the API routes use — one CAS, one lifecycle), the
 * shells runtime, the shellId-keyed realtime IO (`shell-io.ts`), and the
 * WORKER DISPATCH — an internal POST through the standard chat routes, so a
 * spawned worker's turn runs on the exact `ai_stream_sessions` server-owned
 * streaming pipeline a normal conversation uses and shows up live in the
 * sidebar. NEVER a second engine: this module contains no model call.
 *
 * The dispatch acts as the CALLER — it NAMES the acting user in a payload it
 * SIGNS, rather than borrowing that user's browser credential. The worker still
 * runs as the same person who asked for it, through the same admission control
 * (credit gate, takeover discipline) the interactive path runs; what changed is
 * how the internal hop proves itself.
 *
 * It used to forward the live request's own cookie/Bearer/origin out of
 * `next/headers` and mint a CSRF token bound to that session. That made a live
 * browser-ish credential a PRECONDITION for one agent messaging another, so
 * every server-side surface — the voice bridge, cron, the workflow executor, the
 * channel mention responder — was refused outright ("the calling request carries
 * no session credentials to dispatch with"), and an SDK/CLI caller on a Bearer
 * could never reach a global-assistant worker at all. Signing removes the
 * precondition and the forwarded-cookie surface together. See
 * `@pagespace/lib/auth/agent-dispatch-payload` for what the signature does and
 * does not prove.
 *
 * The chain depth rides the SIGNED payload now, and the receiving route rebuilds
 * `X-Agent-Dispatch-Depth` from it, so the pure depth cap keeps terminating
 * across the hop on a value no caller can forge.
 */

import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq, inArray, isNotNull, ne, desc } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { conversations, messages as globalMessages } from '@pagespace/db/schema/conversations';
import { agentWorkspaceNodes } from '@pagespace/db/schema/agent-workspace-nodes';
import { findChatMembership } from '@pagespace/lib/services/agent-workspaces/workspace-membership-store';
import { canUserViewPage, getDriveIdsForUser } from '@pagespace/lib/permissions/permissions';
import { resolveDriveMembership } from '@pagespace/lib/services/agent-workspaces/agent-workspace-tenant';
import { decideAgentSessionAccess } from '@pagespace/lib/agent-workspaces/decide-workspace-access';
import { redactConversationTitleForViewer } from '@pagespace/lib/agent-workspaces/redact-conversation-listing';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  AGENT_DISPATCH_SIGNATURE_HEADER,
  signAgentDispatch,
} from '@pagespace/lib/auth/agent-dispatch-payload';
import { deriveSandboxStatus } from '@pagespace/lib/services/agent-workspaces/workspace-status';
import {
  checkAccessForSubject,
  checkSessionAccess,
  checkSessionEndAccess,
  createConversationInSession,
  endSession,
  ensureDriveSessionForConversation,
  ensureGlobalSandboxSession,
  findSessionForConversation,
  listSessions,
  listSessionConversationsBulk,
  provisionSessionSandbox,
  spawnSession,
  getAgentSessionStore,
} from '@/lib/agent-workspaces/agent-workspaces-runtime';
import { countOpenConversations } from '@/lib/agent-workspaces/conversation-cap';
import { applyLayoutCommandForWorkspace, layoutCommand } from '@/lib/agent-workspaces/workspace-node-placement';
import { readWorkspaceNodes } from '@/lib/agent-workspaces/workspace-node-runtime';
import {
  AgentNotInSessionDriveError,
  SessionFullError,
} from '@/lib/agent-workspaces/create-conversation-in-workspace';
import { MAX_SESSION_CONVERSATIONS } from '@pagespace/lib/agent-workspaces/plan-spawn-worker';
import { conversationRepository } from '@/lib/repositories/conversation-repository';
import {
  getSessionShellStore,
  killShellById,
  listShells,
  spawnShell,
} from '@/lib/agent-workspaces/workspace-shells-runtime';
import { abortConversationStreams } from '@/lib/ai/core/abort-conversation-streams';
import {
  createSessionTools,
  type DispatchOutcome,
  type OwnWorkspaceSummary,
  type SharedWorkspaceSummary,
  type SessionWorkspaceListing,
  type SessionToolsDeps,
  type TranscriptEntry,
} from './session-tools';
import { createShellIo, realtimeShellIoTransport } from './shell-io';
import { conversationPageId } from '@pagespace/lib/conversations/conversation-page';

// ---------------------------------------------------------------------------
// Worker dispatch through the standard chat pipeline
// ---------------------------------------------------------------------------

/**
 * The self base URL for the internal hop.
 *
 * The CONFIGURED origin is authoritative, never the request's routing headers,
 * for two reasons:
 *
 *  1. **Correctness.** Deriving the scheme from `x-forwarded-proto` breaks the
 *     documented plain-HTTP deployment: `host` is present but the forwarded
 *     proto is not, so a header-first resolver builds `https://localhost:3000`
 *     and every dispatch fails before it reaches the chat pipeline.
 *  2. **Safety.** This hop carries a SIGNED dispatch payload. Letting a
 *     client-supplied `x-forwarded-host` choose the destination would let a
 *     forged header steer a valid signature at an attacker-chosen origin, which
 *     is a credential-exfiltration shape whether the credential is a cookie (as
 *     it once was here) or an HMAC. The configured value cannot be influenced
 *     per-request either way; note that only `WEB_APP_URL` is in the boot schema
 *     (`env-validation.ts`), so the `NEXT_PUBLIC_APP_URL` fallback is validated
 *     here rather than at startup — which is why this guard is not redundant.
 *
 * Same precedence as every other self-URL consumer in the repo (see
 * `services/email-service.ts`): `WEB_APP_URL`, then `NEXT_PUBLIC_APP_URL`.
 */
export function resolveSelfBaseUrl(): string | null {
  const configured = process.env.WEB_APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!configured) return null;
  const normalized = configured.replace(/\/$/, '');
  // Absolute HTTP(S) guard. `new URL()` alone is not enough: `localhost:3000` —
  // the single most common way to misconfigure this — parses happily with
  // protocol `localhost:`, so a bare-hostname value would sail through and then
  // fail deep inside `fetch` with an opaque error instead of the actionable
  // "not configured" message this branch exists to produce.
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return normalized;
}

/**
 * The latest completed assistant turn — what a `wait: true` dispatch hands
 * back after the drained stream finishes.
 *
 * ONE conversation-scoped query since the message-table merge (epic
 * "Agent-Session Single Source of Truth", Phase 4 / D6 — reader cutover).
 * Page-anchored transcripts used to live in `chat_messages` and
 * global-assistant ones in `messages`; both now live in `messages`, and a
 * conversation id is globally unique (cuid2), so the `pageId` half of the old
 * page-branch predicate was never load-bearing — the page is
 * `conversations.contextId` and is already implied by the conversation.
 *
 * The global branch GAINS `status <> 'streaming'`, which only the page branch
 * had: a streaming placeholder is an empty row, and returning it as "the
 * reply" reported a completed dispatch as an empty answer. Same correctness
 * class as `readSessionTranscript`'s `pending` mapping below.
 */
async function readLatestAssistantReply(conversationId: string): Promise<string> {
  const [row] = await db
    .select({ content: globalMessages.content })
    .from(globalMessages)
    .where(
      and(
        eq(globalMessages.conversationId, conversationId),
        eq(globalMessages.role, 'assistant'),
        eq(globalMessages.isActive, true),
        ne(globalMessages.status, 'streaming'),
      ),
    )
    .orderBy(desc(globalMessages.createdAt))
    .limit(1);
  return row?.content ?? '';
}

/**
 * POST one turn through the standard chat pipeline as the calling user.
 *
 * `wait: false` returns once the run is ADMITTED (status line received) and
 * abandons the response body — the generation is server-owned
 * (`ai_stream_sessions`) and deliberately not tied to its HTTP reader, so
 * cancelling the body leaves the worker running and visible in active-streams.
 * `wait: true` drains the stream to completion, then reads the reply off the
 * transcript.
 *
 * There is ONE path and no credential branch. The hop signs a payload naming
 * `userId` as the actor; it does not read, forward, or require anything about
 * the ambient request — which is precisely why a voice call, a cron run, a
 * workflow step, and a browser turn can all dispatch identically. See
 * `@pagespace/lib/auth/agent-dispatch-payload`.
 *
 * `scope` is the CEILING inherited from whatever credential started the chain,
 * not a grant. It rides the signed body so a worker dispatched by a drive-scoped
 * MCP token cannot come out the other side of the hop unscoped.
 */
export async function dispatchThroughChatPipeline(input: {
  conversationId: string;
  agentPageId: string | null;
  input: string;
  userId: string;
  depth: number;
  wait: boolean;
  scope: { allowedDriveIds: string[]; mcpTokenId?: string };
}): Promise<DispatchOutcome> {
  const base = resolveSelfBaseUrl();
  if (!base) {
    return {
      ok: false,
      reason: 'failed',
      detail: 'the app\'s own URL is not configured (set WEB_APP_URL or NEXT_PUBLIC_APP_URL)',
    };
  }

  // ONE internal path, whatever the worker is (epic "Agent-Session Single
  // Source of Truth", Phase 5 — chat route consolidation). A page worker sends
  // `chatId`; a global worker sends none, and the receiving route's strategy
  // selection resolves its conversation. The target is now the internal
  // dispatch route rather than the public `/api/ai/chat`, because the public
  // URL's auth matrix is a policy about untrusted clients addressing arbitrary
  // conversation ids — a policy that has no bearing on a hop whose actor the
  // tool layer already authorized, and whose body is signed.
  const url = `${base}/api/internal/agent-dispatch`;

  const { body, signatureHeader } = signAgentDispatch({
    v: 1,
    actingUserId: input.userId,
    conversationId: input.conversationId,
    chatId: input.agentPageId,
    depth: input.depth,
    allowedDriveIds: input.scope.allowedDriveIds,
    ...(input.scope.mcpTokenId ? { originatingMcpTokenId: input.scope.mcpTokenId } : {}),
    // A synthetic id marks a server-side dispatch — it identifies this dispatch,
    // not a browser tab.
    browserSessionId: `agent-dispatch-${createId()}`,
    messageId: createId(),
    text: input.input,
  });

  const requestHeaders: Record<string, string> = {
    'content-type': 'application/json',
    [AGENT_DISPATCH_SIGNATURE_HEADER]: signatureHeader,
  };

  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers: requestHeaders, body });
  } catch (error) {
    // A FIXED message, never the raw fetch/network error (issue #2262 finding
    // 3) — the real cause (DNS, connection refused, TLS) is an internal detail
    // logged server-side, not something to hand a model dispatching a turn.
    loggers.ai.error('session dispatch: could not reach the chat pipeline', error instanceof Error ? error : undefined, {
      conversationId: input.conversationId,
    });
    return { ok: false, reason: 'failed', detail: 'could not reach the chat pipeline to dispatch this turn' };
  }

  if (!response.ok) {
    let detail = `chat pipeline answered ${response.status}`;
    try {
      const parsed = (await response.json()) as { error?: string };
      if (parsed.error) detail = parsed.error;
    } catch {
      // The status line is the answer.
    }
    return { ok: false, reason: 'failed', detail };
  }

  if (!input.wait) {
    // Admitted. The generation is server-owned; the abandoned body must not
    // hold this process's connection open.
    void response.body?.cancel().catch(() => {});
    return { ok: true, waited: false };
  }

  try {
    await response.text();
  } catch (error) {
    loggers.ai.warn('session dispatch: waiting stream ended abnormally', {
      conversationId: input.conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const reply = await readLatestAssistantReply(input.conversationId);
  return { ok: true, waited: true, reply };
}

// ---------------------------------------------------------------------------
// Listings / transcripts
// ---------------------------------------------------------------------------

/**
 * The caller's whole workspace, in the tool family's OWN address namespace:
 * workers are the session's conversations (their ids are what send/read/
 * kill_session take), shells are the workspace's PTYs, and the sandbox status
 * is the one Sprite they all share (review H2b — the old listing enumerated
 * workspace-row ids no verb could address, and never delivered the promised
 * agent labels). Newest first, capped at {@link MAX_SESSION_CONVERSATIONS} —
 * the same ceiling a session's conversations are created under, so the
 * listing can never be truncated by anything the cap didn't already permit
 * to exist (issue #2262 finding 4 — no unbounded `db.select()` feeding model
 * context).
 *
 * Metadata exposure (issue #2262 finding 6): every active conversation in the
 * session lists — including siblings the CALLER did not spawn — by agent and
 * row, to whichever member's agent asks. Shared-workspace semantics: a
 * session is one shared sandbox and filesystem by design, so knowing what
 * else is running there is the same visibility a human teammate has glancing
 * at the sidebar.
 *
 * TITLES follow the one listing redaction rule
 * (`redactConversationTitleForViewer` — full rule documented on
 * `listSessionConversationsBulk`): the workspace's owner sees them all; a
 * caller listing a workspace they do NOT own (their conversation was spawned
 * into a shared one) sees `(private thread)` for siblings that are neither
 * theirs nor deliberately shared.
 *
 * THAT RULE IS ALSO THE ADDRESSABILITY RULE NOW. It used to be strictly weaker
 * than the verbs' gate — this note read "TRANSCRIPT content stays owner-gated
 * either way" — and once the verbs widened from ownership to drive membership,
 * leaving it that way would have shown an agent `(private thread)` for a row it
 * could nonetheless message and read. So the verbs consult the SAME predicate
 * (`isConversationVisibleToViewer`): a foreign worker is addressable exactly
 * when its title is legible here. A thread stays private until its owner shares
 * it, and "seeing a sibling listed here grants no access to what it said" stays
 * true for every redacted row.
 */
async function listWorkspaceWorkers({
  workspaceId,
  callerConversationId,
  callerUserId,
}: {
  workspaceId: string;
  callerConversationId: string;
  callerUserId: string;
}): Promise<SessionWorkspaceListing> {
  const store = await getAgentSessionStore();
  const [row, workerRows, shells] = await Promise.all([
    store.findById(workspaceId),
    db
      .select({
        conversationId: conversations.id,
        title: conversations.title,
        agentPageId: conversations.contextId,
        type: conversations.type,
        agentTitle: pages.title,
        ownerId: conversations.userId,
        isShared: conversations.isShared,
      })
      // MEMBERSHIP IS THE JOIN — the node that binds the thread says which
      // workspace holds it and whether it is on screen, in one row.
      .from(agentWorkspaceNodes)
      .innerJoin(conversations, eq(conversations.id, agentWorkspaceNodes.targetId))
      .leftJoin(pages, eq(pages.id, conversations.contextId))
      .where(
        and(
          eq(agentWorkspaceNodes.rootId, workspaceId),
          eq(agentWorkspaceNodes.targetKind, 'chat'),
          eq(conversations.isActive, true),
          // A thread the human took OFF THE GRID is gone from their pane
          // surface — `list_sessions` must agree, or an agent keeps seeing
          // (and dispatching to) a sibling the user believes they closed. It
          // is the node's own `parentId` now, so the tool's listing and the
          // grid cannot disagree about which threads are showing.
          isNotNull(agentWorkspaceNodes.parentId),
        ),
      )
      .orderBy(desc(conversations.createdAt))
      .limit(MAX_SESSION_CONVERSATIONS),
    listShells(workspaceId),
  ]);

  return {
    sandbox: row ? deriveSandboxStatus(row) : 'none',
    workers: workerRows.map((worker) => ({
      sessionId: worker.conversationId,
      name:
        redactConversationTitleForViewer({
          viewerId: callerUserId,
          // A vanished workspace row (FK-nulled edge) has no owner to grant
          // through — the empty id matches nobody, so the rule fails CLOSED.
          workspaceOwnerId: row?.ownerId ?? '',
          conversation: { ownerId: worker.ownerId, isShared: worker.isShared, title: worker.title },
        }) ?? '',
      agent:
        worker.type === 'page' && worker.agentPageId !== null
          ? { agentId: worker.agentPageId, title: worker.agentTitle ?? '' }
          : null,
      isCaller: worker.conversationId === callerConversationId,
    })),
    shells: shells.map((shell) => ({
      shellId: shell.shellId,
      name: shell.name,
      createdAt: shell.createdAt,
    })),
  };
}

/**
 * ALL the caller's active workspaces (their newest
 * `MAX_ACTIVE_WORKSPACES_PER_OWNER` slice, same as the sidebar — which is all
 * of them, see below) with each one's workers — the discovery half of
 * resource-addressed orchestration: every worker id here is addressable by
 * the verbs from anywhere, and every workspaceId is a valid `spawn_session`
 * `workspace` target. Composed from the SAME primitives the sidebar uses
 * (`listSessions` + `listSessionConversationsBulk`), never a second query
 * shape; agent labels resolved in one batched lookup.
 *
 * Owned, and separately ACCESSIBLE: every row is decided by
 * `decideAgentSessionAccess`, the same one gate `listSharedWorkspaces` and the
 * routes run, because owning a workspace in a drive you have been removed from
 * does not entitle you to it. See the comment on the filter.
 */
async function listOwnWorkspaces({
  userId,
  excludeWorkspaceId,
}: {
  userId: string;
  excludeWorkspaceId?: string;
}): Promise<OwnWorkspaceSummary[]> {
  // The exclusion runs AFTER `listSessions`' own listing cap, not as a
  // query-level filter before it — deliberately, not an oversight: a
  // pre-cap exclusion would need a new filter shape on the shared store
  // (`AgentSessionListFilter`) for a scenario that cannot occur. The store's
  // `.limit()` and the spawn ceiling are the SAME
  // `MAX_ACTIVE_WORKSPACES_PER_OWNER` constant (contract.ts), and the
  // ceiling is STRUCTURAL (`createIfUnderLimit`'s atomic count-and-insert) —
  // no owner can ever HAVE more active workspaces than one listing shows, so
  // `listSessions` never actually truncates here and this filter can never
  // drop a workspace that a pre-cap exclusion would have backfilled (review
  // finding — CodeRabbit; the two-constants coupling this used to lean on is
  // now one constant, pinned by session-list-limit-invariant.test.ts). If
  // the cap ever stops being structural, revisit this filter's ordering.
  const owned = (await listSessions({ ownerId: userId })).filter(
    (session) => session.workspaceId !== excludeWorkspaceId,
  );

  // OWNERSHIP IS NOT ACCESS (review finding — MAJOR, `list_sessions`).
  //
  // This listing filtered on `ownerId` alone, which made it the one
  // session-surface read with no access predicate — `listSharedWorkspaces`
  // below runs `decideAgentSessionAccess` per row, and so does every route.
  // The decision is explicit that the gate binds the OWNER too ("losing the
  // drive loses its working contexts"), so an owner removed from a drive was
  // refused the detail view by `list_sessions`' own revocation re-check and
  // then handed the same workspace one field over, under `otherWorkspaces`.
  // One documented rule, enforced in one branch and waived in its sibling.
  //
  // The SAME one decision, never a second predicate. Membership resolves once
  // per distinct drive rather than per workspace, since an owner's workspaces
  // cluster into few drives; a global-assistant workspace (`driveId` null) is
  // owner-only by construction and needs no lookup at all.
  const driveIds = [...new Set(owned.flatMap((s) => (s.driveId ? [s.driveId] : [])))];
  const membershipByDrive = new Map(
    await Promise.all(
      driveIds.map(
        async (driveId) => [driveId, await resolveDriveMembership({ userId, driveId })] as const,
      ),
    ),
  );
  const sessions = owned.filter(
    (session) =>
      decideAgentSessionAccess({
        requesterId: userId,
        session: { ownerId: session.ownerId, driveId: session.driveId },
        // Absent from the map only if `driveId` is null, which the decision
        // handles on its own branch; `null` there would deny.
        driveMembership: session.driveId ? membershipByDrive.get(session.driveId) ?? null : null,
      }).allowed,
  );
  if (sessions.length === 0) return [];

  const workersBySession = await listSessionConversationsBulk(sessions.map((s) => s.workspaceId));
  const agentTitles = await resolveAgentTitles(workersBySession);

  return sessions.map((session) => ({
    workspaceId: session.workspaceId,
    name: session.name,
    driveId: session.driveId,
    sandbox: session.sandboxStatus,
    workers: (workersBySession.get(session.workspaceId) ?? []).map((worker) => ({
      sessionId: worker.conversationId,
      name: worker.title ?? '',
      agent:
        worker.agentPageId !== null
          ? { agentId: worker.agentPageId, title: agentTitles.get(worker.agentPageId) ?? '' }
          : null,
    })),
  }));
}

/** The one batched agent-label lookup both cross-workspace listings share. */
async function resolveAgentTitles(
  workersBySession: Awaited<ReturnType<typeof listSessionConversationsBulk>>,
): Promise<Map<string, string>> {
  const agentPageIds = [
    ...new Set(
      [...workersBySession.values()].flat().flatMap((w) => (w.agentPageId ? [w.agentPageId] : [])),
    ),
  ];
  const agentTitles = new Map<string, string>();
  if (agentPageIds.length > 0) {
    const agentRows = await db
      .select({ id: pages.id, title: pages.title })
      .from(pages)
      .where(inArray(pages.id, agentPageIds));
    for (const row of agentRows) agentTitles.set(row.id, row.title);
  }
  return agentTitles;
}

/**
 * The most SHARED workspaces (other members' sessions in drives the caller
 * belongs to) one `list_sessions` call reports. The caller's OWN set needs
 * no such bound — `MAX_ACTIVE_WORKSPACES_PER_OWNER` is a structural spawn
 * ceiling, so a listing can never truncate it — but the member-visible set
 * has no structural ceiling behind it (N members × their own caps), so this
 * cap is a REAL truncation bound: newest activity first, the rest silently
 * beyond the horizon. Sized to the same figure as the own-set cap
 * (`MAX_ACTIVE_WORKSPACES_PER_OWNER`) so one listing's total stays
 * model-context-shaped.
 */
const MAX_MEMBER_VISIBLE_WORKSPACES = 100;

/**
 * Workspaces the caller can ACCESS as a drive member without owning them —
 * the discovery HALF of the spawn gate, restoring symmetry PR #2336 flagged:
 * `spawn_session`'s explicit-`workspaceId` path admits any caller
 * `checkSessionAccess` allows (owner OR drive member), while discovery only
 * enumerated owned workspaces — so a member could target a shared workspace
 * by id but never learn the id from `list_sessions`.
 *
 * Per-row access is decided by the SAME one pure decision the spawn gate
 * uses — `decideAgentSessionAccess`, fed by the same `resolveDriveMembership`
 * gather (`checkAccessForSubject`'s exact composition) — never a second
 * predicate. Candidate drives come from the caller's drive relationships
 * (`getDriveIdsForUser`, deliberately over-broad: it includes
 * page-permission-only drives whose membership resolves to `'none'`, which
 * the decision then denies — an over-broad candidate set filtered by the one
 * real gate beats a hand-rolled narrower query that could drift from it).
 *
 * Worker rows come from the same `listSessionConversationsBulk` primitive as
 * every other listing, with titles routed through the ONE redaction rule
 * (`redactConversationTitleForViewer`): the caller sees their own and
 * deliberately-shared titles; another member's private thread keeps its row
 * (agent + activity — the orchestration signal) as `(private thread)`, and is
 * not addressable by the verbs either — same predicate, one answer.
 * Bounded by {@link MAX_MEMBER_VISIBLE_WORKSPACES} (see its doc).
 */
async function listSharedWorkspaces({
  userId,
  excludeWorkspaceId,
}: {
  userId: string;
  excludeWorkspaceId?: string;
}): Promise<SharedWorkspaceSummary[]> {
  const candidateDriveIds = await getDriveIdsForUser(userId);
  if (candidateDriveIds.length === 0) return [];

  const memberships = await Promise.all(
    candidateDriveIds.map(async (driveId) => ({
      driveId,
      membership: await resolveDriveMembership({ userId, driveId }),
    })),
  );

  const sessionsPerDrive = await Promise.all(
    memberships
      .filter(({ membership }) => membership !== 'none')
      .map(async ({ driveId, membership }) => {
        // The ownerless `{ driveId }` filter: every ACTIVE session in the
        // drive, any owner — the sidebar's own store primitive, its per-query
        // cap included.
        const sessions = await listSessions({ driveId });
        return sessions.filter(
          (session) =>
            // The caller's own sessions belong to the OWN listing; the
            // current workspace is the top-level detail view.
            session.ownerId !== userId &&
            session.workspaceId !== excludeWorkspaceId &&
            // THE gate — the same pure decision `checkSessionAccess` applies
            // on spawn_session's explicit-workspaceId path.
            decideAgentSessionAccess({
              requesterId: userId,
              session: { ownerId: session.ownerId, driveId: session.driveId },
              driveMembership: membership,
            }).allowed,
        );
      }),
  );

  const shared = sessionsPerDrive
    .flat()
    .sort((a, b) => {
      // Newest activity first, nulls last, then newest created — the store's
      // own listing order, re-established across the merged drives.
      const activity = (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? '');
      return activity !== 0 ? activity : b.createdAt.localeCompare(a.createdAt);
    })
    .slice(0, MAX_MEMBER_VISIBLE_WORKSPACES);
  if (shared.length === 0) return [];

  const workersBySession = await listSessionConversationsBulk(shared.map((s) => s.workspaceId));
  const agentTitles = await resolveAgentTitles(workersBySession);

  return shared.map((session) => ({
    workspaceId: session.workspaceId,
    name: session.name,
    // Non-null by construction: only drive-scoped sessions pass the filter
    // (a global-assistant session is owner-only, and own rows are excluded).
    driveId: session.driveId ?? '',
    sandbox: session.sandboxStatus,
    workers: (workersBySession.get(session.workspaceId) ?? []).map((worker) => ({
      sessionId: worker.conversationId,
      name:
        redactConversationTitleForViewer({
          viewerId: userId,
          workspaceOwnerId: session.ownerId,
          conversation: { ownerId: worker.ownerId, isShared: worker.isShared, title: worker.title },
        }) ?? '',
      agent:
        worker.agentPageId !== null
          ? { agentId: worker.agentPageId, title: agentTitles.get(worker.agentPageId) ?? '' }
          : null,
      lastActiveAt: worker.lastMessageAt?.toISOString() ?? null,
    })),
  }));
}

/**
 * A worker's recent turns, oldest-last-N first.
 *
 * ONE conversation-scoped query since the message-table merge (Phase 4 / D6 —
 * reader cutover). The old `agentPageId === null` branch picked the TABLE, not
 * the rows: `messages` for global-assistant threads, `chat_messages` for
 * page-anchored ones. With one table the branch has nothing left to decide —
 * `conversationId` alone selects the thread (cuid2, globally unique), and a
 * page conversation's page is `conversations.contextId`, already implied.
 *
 * GLOBAL THREADS GAIN THE `pending` MAPPING. Only the page branch carried
 * `status === 'streaming' ⇒ pending`; the global branch did not even select
 * `status`, so a turn still being generated was handed to the model as a
 * completed, empty message. Both now report it honestly. This is a deliberate
 * behaviour change on global threads and the one intended non-parity in this
 * reader.
 */
async function readSessionTranscript(input: {
  conversationId: string;
  agentPageId: string | null;
  limit: number;
}): Promise<TranscriptEntry[]> {
  const rows = await db
    .select({
      role: globalMessages.role,
      content: globalMessages.content,
      createdAt: globalMessages.createdAt,
      status: globalMessages.status,
    })
    .from(globalMessages)
    .where(and(eq(globalMessages.conversationId, input.conversationId), eq(globalMessages.isActive, true)))
    .orderBy(desc(globalMessages.createdAt))
    .limit(input.limit);
  return rows.reverse().map((row) => ({
    role: row.role === 'assistant' ? ('assistant' as const) : ('user' as const),
    content: row.content,
    at: row.createdAt,
    // A streaming placeholder is a turn still being generated — reported
    // honestly rather than read as an empty answer.
    ...(row.status === 'streaming' ? { pending: true as const } : {}),
  }));
}

// ---------------------------------------------------------------------------
// The wired deps
// ---------------------------------------------------------------------------

type CallerSessionResolution =
  | { ok: true; session: NonNullable<Awaited<ReturnType<typeof findSessionForConversation>>> }
  | { ok: false; reason: 'no_session' | 'session_limit_reached' | 'not_permitted' };

/**
 * Resolve the SESSION a worker would join for a caller conversation — a
 * worker works in its SPAWNER's workspace: same session, same sandbox, same
 * filesystem; that shared context is the point of spawning one.
 *
 * PERMISSION gates minting; workspace lifecycle state never does (issue
 * #2335's product decision — orchestration must work from any surface):
 *
 *  - A bound session is used AS IS, even if ended: ended sessions are
 *    resumable by the lifecycle's own model (ensure fresh-provisions them),
 *    and the worker's claim reopens the listing (`planSessionReopen`).
 *  - An unbound GLOBAL conversation mints a global session — the caller acts
 *    with the user's own authority, which is the whole permission check.
 *  - An unbound PAGE conversation mints a session in ITS AGENT'S drive,
 *    gated by the exact primitives the manual "New session" route enforces:
 *    the agent view check plus `checkAccessForSubject` on the drive. Same
 *    rules, one source of truth — no tool-only policy.
 *
 * Exported for unit tests.
 */
export async function resolveCallerSessionForWorker(
  callerConversationId: string,
  ownerId: string,
): Promise<CallerSessionResolution> {
  const existing = await findSessionForConversation(callerConversationId);
  if (existing) {
    // A bound session is used AS IS — but "bound" is not "still allowed". The
    // binding is PERMANENT and drive membership is not, so without this the
    // early return hands a revoked member a worker (and therefore code
    // execution) inside another tenant's live sandbox and filesystem — the
    // richest thing this file can grant, on the one path that used to check
    // nothing. This is the SAME permission decision the explicit-workspaceId
    // branch of `resolveWorkerPlacement` runs, and it is permission-only:
    // `decideAgentSessionAccess` reads owner + drive membership and never
    // lifecycle state, so an ENDED session still resolves here exactly as
    // #2335 requires. Only revocation refuses.
    const access = await checkSessionAccess(ownerId, existing.id);
    if (!access.allowed) return { ok: false, reason: 'not_permitted' };
    return { ok: true, session: existing };
  }

  const conversation = await conversationRepository.getConversation(callerConversationId);
  if (!conversation || conversation.userId !== ownerId || !conversation.isActive) {
    return { ok: false, reason: 'no_session' };
  }

  if (conversation.type === 'global') {
    return mapEnsured(await ensureGlobalSandboxSession(callerConversationId, ownerId));
  }

  if (conversation.type === 'page' && conversation.contextId !== null) {
    const agent = await conversationRepository.getAiAgent(conversation.contextId);
    if (!agent) return { ok: false, reason: 'no_session' };
    if (!(await canUserViewPage(ownerId, agent.id))) return { ok: false, reason: 'not_permitted' };
    const access = await checkAccessForSubject(ownerId, {
      ownerId,
      driveId: agent.driveId,
    });
    if (!access.allowed) return { ok: false, reason: 'not_permitted' };
    return mapEnsured(await ensureDriveSessionForConversation(callerConversationId, ownerId, agent.driveId));
  }

  // 'client' (API-managed) rows have no in-app viewer — same policy the
  // claim route applies.
  return { ok: false, reason: 'no_session' };
}

function mapEnsured(
  ensured: Awaited<ReturnType<typeof ensureGlobalSandboxSession>>,
): CallerSessionResolution {
  if (ensured.ok) return { ok: true, session: ensured.session };
  return {
    ok: false,
    reason: ensured.reason === 'session_limit_reached' ? 'session_limit_reached' : 'no_session',
  };
}

type CreateWorkerSessionFailure = Extract<
  Awaited<ReturnType<SessionToolsDeps['createWorkerSession']>>,
  { ok: false }
>;

/**
 * Resolve WHERE a spawned worker lands — permission-gated, never binding-
 * state-gated (issue #2335). The three `workspace` shapes `createWorkerSession`
 * accepts, isolated into one place so its own body reads as a straight-line
 * pipeline: resolve placement, then create, then map errors.
 */
async function resolveWorkerPlacement(input: {
  workspace: string | undefined;
  callerConversationId: string;
  ownerId: string;
  agentPageId: string | null;
}): Promise<
  | { ok: true; workspaceId: string; unwind: (() => Promise<void>) | null }
  | CreateWorkerSessionFailure
> {
  const { workspace, callerConversationId, ownerId, agentPageId } = input;

  if (workspace === undefined) {
    // The caller's own workspace — minted if it has none.
    const resolved = await resolveCallerSessionForWorker(callerConversationId, ownerId);
    if (!resolved.ok) {
      if (resolved.reason === 'session_limit_reached') {
        return { ok: false, reason: 'session_limit_reached', detail: 'You are at your active-session limit — end an existing session first.' };
      }
      if (resolved.reason === 'not_permitted') {
        return { ok: false, reason: 'not_permitted', detail: 'You are not permitted to start a session for this agent\'s drive.' };
      }
      return { ok: false, reason: 'no_session', detail: 'This conversation has no session for a worker to join.' };
    }
    return { ok: true, workspaceId: resolved.session.id, unwind: null };
  }

  if (workspace === 'new') {
    // A fresh ISOLATED workspace — its own sandbox and filesystem, for
    // fan-out that must not share the caller's working context. It lives
    // where its AGENT lives: a page agent's drive, or nowhere (global) — the
    // same derivation the caller-thread minting path uses, gated by the same
    // spawn-access primitive.
    let driveId: string | null = null;
    if (agentPageId !== null) {
      const agent = await conversationRepository.getAiAgent(agentPageId);
      if (!agent) {
        return { ok: false, reason: 'conversation_unavailable', detail: 'That agent is not available.' };
      }
      driveId = agent.driveId;
    }
    const access = await checkAccessForSubject(ownerId, { ownerId, driveId });
    if (!access.allowed) {
      return { ok: false, reason: 'not_permitted', detail: 'You are not permitted to start a workspace there.' };
    }
    const spawned = await spawnSession({ userId: ownerId, driveId });
    if (!spawned.ok) {
      return spawned.reason === 'session_limit_reached'
        ? { ok: false, reason: 'session_limit_reached', detail: 'You are at your active-session limit — end an existing session first.' }
        : { ok: false, reason: 'spawn_failed', detail: 'Could not start a new workspace — try again.' };
    }
    // A fresh workspace minted FOR this spawn is unwound if the worker never
    // lands in it — an empty session is the invariant violation the spawn
    // route unwinds the same way.
    const unwind = async () => {
      await endSession(spawned.session.id).catch((cleanupError) => {
        loggers.ai.warn('createWorkerSession: failed to unwind an empty minted workspace', {
          workspaceId: spawned.session.id,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      });
    };
    return { ok: true, workspaceId: spawned.session.id, unwind };
  }

  // An existing workspaceId, gated by the ONE session access decision
  // (`checkSessionAccess` — owner or drive member).
  const access = await checkSessionAccess(ownerId, workspace);
  if (!access.allowed) {
    // Missing, foreign, and not-a-member all read identically — an
    // id-guessing caller learns nothing.
    return { ok: false, reason: 'workspace_not_found', detail: `There is no workspace "${workspace}" you can use. Call list_sessions to see yours.` };
  }
  return { ok: true, workspaceId: workspace, unwind: null };
}

/**
 * After `createConversationInSession` throws with a freshly-minted,
 * unwindable workspace, determine whether the worker's claim actually
 * COMMITTED despite the throw before tearing anything down.
 *
 * The claim's guarded UPDATE may have committed before this call saw the
 * failure — the exact ambiguous-throw hazard `ensureGlobalSandboxSession`
 * already documents and guards against elsewhere in this file (a connection
 * dropping between a durable autocommit write and its acknowledgment).
 * Unwinding blind on that false negative would end a session the worker is
 * genuinely bound to: a bound-but-ended worker conversation is unreachable
 * forever afterward (nothing will ever claim or list a freshly-minted-then-
 * ended session again), which is worse than the failure this call would
 * otherwise just report.
 *
 * `workerConversationId` was freshly minted by the caller of this dep, so it
 * can only resolve to unbound or to exactly the workspace just minted —
 * never a sibling's, unlike the caller-conversation case this pattern is
 * mirrored from.
 */
async function recoverMintedWorkspaceAfterThrow(
  workerConversationId: string,
  workspaceId: string,
  unwind: () => Promise<void>,
): Promise<'bound' | 'not_bound'> {
  let boundAfterThrow: Awaited<ReturnType<typeof findSessionForConversation>> = null;
  let verificationFailed = false;
  try {
    boundAfterThrow = await findSessionForConversation(workerConversationId);
    if (!boundAfterThrow) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      boundAfterThrow = await findSessionForConversation(workerConversationId);
    }
  } catch (lookupError) {
    verificationFailed = true;
    loggers.ai.warn('createWorkerSession: failed to re-resolve a new worker\'s binding after a claim exception', {
      workerConversationId,
      workspaceId,
      error: lookupError instanceof Error ? lookupError.message : String(lookupError),
    });
  }
  if (boundAfterThrow?.id === workspaceId) return 'bound';
  if (!verificationFailed) {
    // Confirmed unbound — safe to unwind the empty workspace.
    await unwind();
  }
  // Verification itself failed: leave the workspace alone rather than gamble
  // — a stray, empty, endable-by-hand workspace is cheap and recoverable;
  // wrongly killing one a worker is bound to is not.
  return 'not_bound';
}

/**
 * A workspace's owner, for the one gate that needs it: a caller who OWNS the
 * workspace sees and addresses every thread in it, including other members'
 * private ones (they are the tenant of that working context). Read through the
 * same session store the rest of the runtime uses.
 */
async function getWorkspaceOwnerId(workspaceId: string): Promise<string | null> {
  const store = await getAgentSessionStore();
  const row = await store.findById(workspaceId);
  return row?.ownerId ?? null;
}

export function buildSessionToolsDeps(): SessionToolsDeps {
  return {
    findOwnWorkspace: async (conversationId) => {
      const row = await findSessionForConversation(conversationId);
      return row ? { workspaceId: row.id } : null;
    },

    // THE session-access decision, wired for the tool surface exactly as the
    // verbs route wires it (security review HIGH 2). Resolving a conversation's
    // binding says the workspace is addressable, never that it is still usable
    // — drive membership can be revoked out from under a permanent binding.
    checkWorkspaceAccess: (userId, workspaceId) => checkSessionAccess(userId, workspaceId),
    // The END variant, through the SAME wrapper the verbs route uses — which is
    // where `canRunCode` is already gathered, so routing through it rather than
    // re-deciding here is what keeps the capability gate live without a second
    // wiring for it to drift from.
    checkWorkspaceEndAccess: (userId, workspaceId) => checkSessionEndAccess(userId, workspaceId),
    listWorkspaceWorkers,
    listOwnWorkspaces,
    listSharedWorkspaces,

    findWorker: async (conversationId) => {
      // The wire's "sessionId" is the WORKER's conversation id (what spawn
      // returned) — resolve the conversation, not a workspace row.
      const conversation = await conversationRepository.getConversation(conversationId);
      if (!conversation) return null;
      // A history-deleted worker is not addressable. Load-bearing now that
      // `openOwnSession` authorizes by the RESOURCE alone (ownership +
      // bound + not closed) rather than by workspace membership — the old
      // workspace comparison incidentally masked deleted rows.
      if (!conversation.isActive) return null;
      // MEMBERSHIP, from the tree: which workspace holds this thread, and
      // whether it is on screen there. Two facts off ONE row, where they used
      // to be two columns nothing kept in correspondence.
      const membership = await findChatMembership(db, conversationId);
      return {
        conversationId,
        ownerId: conversation.userId,
        agentPageId: conversationPageId(conversation),
        name: conversation.title ?? '',
        // The WORKSPACE whose tree holds this thread — the membership read,
        // through the node's global chat-target index rather than a column.
        // `openOwnSession` requires it non-null (a plain thread is not a
        // worker) but no longer compares it to the caller's own workspace —
        // worker verbs are resource-addressed (issue #2335 product decision).
        workspaceId: membership?.workspaceId ?? null,
        // The human CLOSED this conversation out of its workspace, so its node
        // is gone. `openOwnSession` refuses on this, so a worker verb can never
        // dispatch new work into, read, or kill a worker the user has already
        // closed.
        //
        // It used to be "the node is parked" — a row that survived the close
        // with a null parent. Closing destroys the node, so the absence of a
        // membership row IS the closed state, which is also why `workspaceId`
        // above goes null in the same breath. A worker verb addressed at a
        // closed thread therefore fails the `workspaceId` gate first; this stays
        // so the answer keeps its own name rather than becoming "never had one".
        isClosed: membership === null,
        // The two facts `isConversationVisibleToViewer` needs to decide whether
        // a NON-owner may address this worker. Carried on the row rather than
        // re-read at the gate so the verbs and the listing weigh the same
        // values, not merely the same rule.
        isShared: conversation.isShared,
        workspaceOwnerId: membership ? (await getWorkspaceOwnerId(membership.workspaceId)) : null,
      };
    },

    // The ONE shared open-conversation count (`conversation-cap.ts`) — the
    // same predicate the HTTP creation path's cap enforces, so a closed
    // listing frees its cap slot here too by construction, not by mirroring.
    countOpenConversations: (workspaceId) => countOpenConversations(workspaceId),

    canUseAgent: async (userId, agentPageId) => {
      const page = await db.query.pages.findFirst({
        where: and(eq(pages.id, agentPageId), eq(pages.type, 'AI_CHAT'), eq(pages.isTrashed, false)),
        columns: { id: true },
      });
      if (!page) return false;
      return canUserViewPage(userId, agentPageId);
    },

    createWorkerSession: async ({ conversationId, callerConversationId, ownerId, agentPageId, name, workspace }) => {
      const placement = await resolveWorkerPlacement({ workspace, callerConversationId, ownerId, agentPageId });
      if (!placement.ok) return placement;
      const { workspaceId, unwind } = placement;

      try {
        await createConversationInSession({
          conversationId,
          userId: ownerId,
          agentPageId,
          workspaceId,
          // The spawning conversation shares this grid when the worker lands in
          // the caller's own workspace — never evicted by its own spawn.
          excludeTargetId: callerConversationId,
          // The worker's label, written AT BIRTH onto the conversation row —
          // it is what the sidebar and list_sessions display (codex review,
          // P2: the old path reported the name in the tool response and then
          // discarded it).
          title: name,
        });
      } catch (error) {
        if (unwind) {
          const recovered = await recoverMintedWorkspaceAfterThrow(conversationId, workspaceId, unwind);
          if (recovered === 'bound') return { ok: true, workspaceId };
        }
        // A FIXED message per known cause, never the raw driver/error string
        // (issue #2262 finding 3): a database error's text is an internal
        // implementation detail, not something a model should read or repeat.
        // The real error is logged server-side for whoever debugs the denial.
        if (error instanceof SessionFullError) {
          return { ok: false, reason: 'session_full', detail: 'This session already has its maximum number of conversations.' };
        }
        if (error instanceof AgentNotInSessionDriveError) {
          return { ok: false, reason: 'conversation_unavailable', detail: 'That agent belongs to a different drive than this session.' };
        }
        // ConversationUnavailableError is logged too — it is deliberately
        // generic toward the CALLER, which is exactly why the server log must
        // say which gate refused (issue #2335: excluding it here meant a
        // deterministic denial left no trace anywhere). The logger serializes
        // only name/message/stack, so the wrapped cause is surfaced in the
        // metadata explicitly.
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
        loggers.ai.error('createWorkerSession: could not create the worker conversation', error instanceof Error ? error : undefined, {
          conversationId,
          callerConversationId,
          ownerId,
          ...(cause ? { cause: `${cause.name}: ${cause.message}` } : {}),
        });
        return { ok: false, reason: 'conversation_unavailable', detail: 'That conversation id is not available.' };
      }
      return { ok: true, workspaceId };
    },

    // The layout family's two seams (issue #2208). The read is the SAME atomic
    // snapshot the `/nodes` GET serves, so a model and a browser never see
    // different names — or different trees — for the same workspace; the write
    // is the same single writer behind that route.
    readPaneGrid: async (workspaceId, viewerId) => {
      const snapshot = await readWorkspaceNodes(workspaceId, viewerId);
      if (snapshot.nodes.length === 0) return null;
      // Titles ride BESIDE the tree because they are authority and the tree is
      // not; the model is one viewer, so they are folded back in here for it.
      const titles = new Map(snapshot.targets.map((target) => [`${target.kind}:${target.id}`, target.title]));
      return {
        nodes: snapshot.nodes.map((node) => {
          const target = node.nodeType === 'pane' ? node.target : null;
          return {
            nodeId: node.id,
            nodeType: node.nodeType,
            parentId: node.parentId,
            position: node.position,
            axis: node.nodeType === 'pane' ? null : node.axis,
            kind: target?.kind ?? null,
            targetId: target?.id ?? null,
            // A target the viewer may not name resolves to nothing, and the
            // node still renders — refusing to resolve is deliberately
            // indistinguishable from "gone".
            name: target === null ? '' : titles.get(`${target.kind}:${target.id}`) ?? '',
            fraction: node.nodeType === 'root' ? null : node.fraction ?? null,
          };
        }),
      };
    },

    // The model names a COMMAND; the server compiles it against the tree it
    // holds under the lock. A command whose target id no longer exists is
    // refused by the algebra, never clamped into something else.
    applyLayoutCommand: async ({ workspaceId, actingUserId, command }) =>
      applyLayoutCommandForWorkspace({ workspaceId, actingUserId, run: layoutCommand(command) }),

    dispatch: dispatchThroughChatPipeline,

    readTranscript: readSessionTranscript,

    killWorker: async ({ conversationId, streamOwnerId, actingUserId }) => {
      // Abort as the STREAM'S OWNER, not the caller.
      //
      // `abortConversationStreams` filters `ai_stream_sessions` by user id and
      // re-checks ownership per abort — deliberately stricter than the takeover's,
      // so an explicit user Stop can never reach someone else's generation. That
      // is right for a Stop button and wrong here: once the END decision has
      // authorized a drive admin to stop another member's worker, aborting as the
      // ADMIN would match zero rows and report success while the worker kept
      // running. Authorization happened before this call; this names the rows.
      void actingUserId;
      await abortConversationStreams({ conversationId, userId: streamOwnerId }).catch(() => {});
      // Deliberately NO sandbox teardown: a worker works in its SPAWNER's
      // workspace, so tearing "its" sandbox down would destroy a working context
      // that is not this worker's to release.
      return { ok: true, spriteTornDown: false };
    },

    ensureOwnSessionSandbox: async ({ conversationId, userId, agentPageId }) => {
      void agentPageId;
      const row = await findSessionForConversation(conversationId);
      if (!row) {
        return { ok: false, error: "This conversation has no session — open it inside a session to use shells." };
      }
      const provisioned = await provisionSessionSandbox(row, userId);
      if (!provisioned.ok) {
        return {
          ok: false,
          error:
            provisioned.reason === 'denied'
              ? 'You are not authorized to run a sandbox here.'
              : `Could not provision this session's sandbox (${provisioned.detail ?? provisioned.reason}).`,
        };
      }
      return { ok: true };
    },

    spawnShell: async ({ conversationId, ownerId, name }) => {
      // The pure layer hands the CALLER's conversation id; shells hang off the
      // WORKSPACE, so resolve the working context first.
      const session = await findSessionForConversation(conversationId);
      if (!session) return { ok: false, reason: 'no_session' };
      const spawned = await spawnShell({ workspaceId: session.id, ownerId, name });
      if (!spawned.ok) return { ok: false, reason: spawned.reason };
      return { ok: true, shell: spawned.shell };
    },

    findShell: async (shellId) => {
      const store = await getSessionShellStore();
      const row = await store.findById(shellId);
      if (!row) return null;
      return {
        shellId: row.id,
        workspaceId: row.workspaceId,
        name: row.name,
        ...(row.coldTail !== null || row.coldTailHasOutput
          ? {
              cold: {
                tail: row.coldTail ?? '',
                at: row.coldTailAt ?? new Date(0),
                hasOutput: row.coldTailHasOutput,
              },
            }
          : {}),
      };
    },

    killShell: async (shellId) => {
      const killed = await killShellById(shellId);
      if (!killed.ok) return { ok: false, reason: killed.reason };
      return { ok: true, killed: killed.killed };
    },

    shellIo: createShellIo(realtimeShellIoTransport),

    newId: createId,
  };
}

/** Production session + shell tools, fully wired. Registered behind the CODE_EXECUTION kill-switch. */
export function buildSessionTools() {
  return createSessionTools(buildSessionToolsDeps());
}
