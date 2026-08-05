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
 * The dispatch forwards the CALLER's own credentials (cookie/CSRF/origin from
 * the live request via `next/headers`) — the worker acts as the same user who
 * asked for it, through the same admission control (credit gate, takeover
 * discipline) the interactive path runs. The chain depth rides the
 * `X-Agent-Dispatch-Depth` header, which both chat routes fold back into
 * `agentCallDepth` so the pure depth cap keeps terminating across the hop.
 */

import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, count, eq, inArray, isNull, ne, desc } from '@pagespace/db/operators';
import { chatMessages, pages } from '@pagespace/db/schema/core';
import { conversations, messages as globalMessages } from '@pagespace/db/schema/conversations';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { deriveSandboxStatus } from '@pagespace/lib/services/agent-sessions/session-status';
import {
  checkAccessForSubject,
  checkSessionAccess,
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
} from '@/lib/agent-sessions/agent-sessions-runtime';
import {
  AgentNotInSessionDriveError,
  SessionFullError,
} from '@/lib/agent-sessions/create-conversation-in-session';
import { MAX_SESSION_CONVERSATIONS } from '@pagespace/lib/agent-sessions/plan-spawn-session';
import { conversationRepository } from '@/lib/repositories/conversation-repository';
import {
  getSessionShellStore,
  killShellById,
  listShells,
  spawnShell,
} from '@/lib/agent-sessions/session-shells-runtime';
import { abortConversationStreams } from '@/lib/ai/core/abort-conversation-streams';
import {
  createSessionTools,
  type DispatchOutcome,
  type OwnWorkspaceSummary,
  type SessionWorkspaceListing,
  type SessionToolsDeps,
  type TranscriptEntry,
} from './session-tools';
import { createShellIo, realtimeShellIoTransport } from './shell-io';

// ---------------------------------------------------------------------------
// Worker dispatch through the standard chat pipeline
// ---------------------------------------------------------------------------

/** The headers the dispatch forwards verbatim — the caller's own credentials. */
const FORWARDED_HEADERS = ['cookie', 'x-csrf-token', 'origin', 'referer'] as const;

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
 *  2. **Safety.** This hop forwards the caller's own cookie and CSRF token
 *     (see `FORWARDED_HEADERS`). Letting a client-supplied `x-forwarded-host`
 *     choose the destination would let a forged header steer those credentials
 *     at an attacker-chosen origin. The configured value cannot be influenced
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
 * back after the drained stream finishes. Page-anchored transcripts live in
 * `chat_messages`; global-assistant ones in `messages`.
 */
async function readLatestAssistantReply(sessionId: string, agentPageId: string | null): Promise<string> {
  if (agentPageId === null) {
    const [row] = await db
      .select({ content: globalMessages.content })
      .from(globalMessages)
      .where(
        and(
          eq(globalMessages.conversationId, sessionId),
          eq(globalMessages.role, 'assistant'),
          eq(globalMessages.isActive, true),
        ),
      )
      .orderBy(desc(globalMessages.createdAt))
      .limit(1);
    return row?.content ?? '';
  }
  const [row] = await db
    .select({ content: chatMessages.content })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.pageId, agentPageId),
        eq(chatMessages.conversationId, sessionId),
        eq(chatMessages.role, 'assistant'),
        eq(chatMessages.isActive, true),
        ne(chatMessages.status, 'streaming'),
      ),
    )
    .orderBy(desc(chatMessages.createdAt))
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
 */
async function dispatchThroughChatPipeline(input: {
  sessionId: string;
  agentPageId: string | null;
  input: string;
  userId: string;
  depth: number;
  wait: boolean;
}): Promise<DispatchOutcome> {
  let incoming: Headers;
  try {
    const { headers } = await import('next/headers');
    incoming = await headers();
  } catch {
    return {
      ok: false,
      reason: 'failed',
      detail: 'no live request to dispatch from (worker dispatch needs the calling user\'s own request context)',
    };
  }

  const base = resolveSelfBaseUrl();
  if (!base) {
    return {
      ok: false,
      reason: 'failed',
      detail: 'the app\'s own URL is not configured (set WEB_APP_URL or NEXT_PUBLIC_APP_URL)',
    };
  }
  if (!incoming.get('cookie')) {
    return { ok: false, reason: 'failed', detail: 'the calling request carries no session credentials to dispatch with' };
  }

  const url =
    input.agentPageId === null
      ? `${base}/api/ai/global/${encodeURIComponent(input.sessionId)}/messages`
      : `${base}/api/ai/chat`;

  const requestHeaders: Record<string, string> = {
    'content-type': 'application/json',
    // Required by both routes; a synthetic id marks a server-side dispatch —
    // it identifies this dispatch, not a browser tab.
    'x-browser-session-id': `agent-dispatch-${createId()}`,
    'x-agent-dispatch-depth': String(input.depth),
  };
  for (const name of FORWARDED_HEADERS) {
    const value = incoming.get(name);
    if (value) requestHeaders[name] = value;
  }

  const body = JSON.stringify({
    ...(input.agentPageId !== null ? { chatId: input.agentPageId } : {}),
    conversationId: input.sessionId,
    messages: [
      { id: createId(), role: 'user', parts: [{ type: 'text', text: input.input }] },
    ],
  });

  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers: requestHeaders, body });
  } catch (error) {
    // A FIXED message, never the raw fetch/network error (issue #2262 finding
    // 3) — the real cause (DNS, connection refused, TLS) is an internal detail
    // logged server-side, not something to hand a model dispatching a turn.
    loggers.ai.error('session dispatch: could not reach the chat pipeline', error instanceof Error ? error : undefined, {
      sessionId: input.sessionId,
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
      sessionId: input.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const reply = await readLatestAssistantReply(input.sessionId, input.agentPageId);
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
 * DELIBERATE metadata exposure (issue #2262 finding 6): this lists EVERY
 * active conversation in the session — including siblings the CALLER did not
 * spawn and does not own — by title and agent, to whichever member's agent
 * asks. That is shared-workspace semantics, not a leak: a session is one
 * shared sandbox and filesystem by design, so knowing what else is running
 * there is the same visibility a human teammate has glancing at the sidebar.
 * What stays owner-gated is TRANSCRIPT content — `read_session` still requires
 * `openOwnSession`'s ownership check, so seeing a sibling listed here grants
 * no access to what it said.
 */
async function listSessionWorkers({
  workspaceSessionId,
  callerConversationId,
}: {
  workspaceSessionId: string;
  callerConversationId: string;
}): Promise<SessionWorkspaceListing> {
  const store = await getAgentSessionStore();
  const [row, workerRows, shells] = await Promise.all([
    store.findById(workspaceSessionId),
    db
      .select({
        conversationId: conversations.id,
        title: conversations.title,
        agentPageId: conversations.contextId,
        type: conversations.type,
        agentTitle: pages.title,
      })
      .from(conversations)
      .leftJoin(pages, eq(pages.id, conversations.contextId))
      .where(
        and(
          eq(conversations.sessionId, workspaceSessionId),
          eq(conversations.isActive, true),
          // A closed listing is gone from the human's sidebar — `list_sessions`
          // must agree, or an agent keeps seeing (and dispatching to) a
          // sibling the user believes they already closed.
          isNull(conversations.closedInSessionAt),
        ),
      )
      .orderBy(desc(conversations.createdAt))
      .limit(MAX_SESSION_CONVERSATIONS),
    listShells(workspaceSessionId),
  ]);

  return {
    sandbox: row ? deriveSandboxStatus(row) : 'none',
    workers: workerRows.map((worker) => ({
      sessionId: worker.conversationId,
      name: worker.title ?? '',
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
 * ALL the caller's active workspaces (their newest `SESSION_LIST_LIMIT`
 * slice, same as the sidebar) with each one's workers — the discovery half of
 * resource-addressed orchestration: every worker id here is addressable by
 * the verbs from anywhere, and every workspaceId is a valid `spawn_session`
 * `workspace` target. Composed from the SAME primitives the sidebar uses
 * (`listSessions` + `listSessionConversationsBulk`), never a second query
 * shape; agent labels resolved in one batched lookup.
 */
async function listOwnWorkspaces({
  userId,
  excludeWorkspaceSessionId,
}: {
  userId: string;
  excludeWorkspaceSessionId?: string;
}): Promise<OwnWorkspaceSummary[]> {
  // The exclusion runs AFTER `listSessions`' own SESSION_LIST_LIMIT cap, not
  // as a query-level filter before it — deliberately, not an oversight: a
  // pre-cap exclusion would need a new filter shape on the shared store
  // (`AgentSessionListFilter`) for a scenario that cannot occur today.
  // `SESSION_LIST_LIMIT` and `MAX_ACTIVE_SESSIONS_PER_OWNER` are both 100,
  // and the latter is a STRUCTURAL cap (`createIfUnderLimit`'s atomic
  // count-and-insert) — no owner can ever HAVE more than 100 active
  // sessions, so `listSessions` never actually truncates here and this
  // filter can never drop a workspace that a pre-cap exclusion would have
  // backfilled (review finding — CodeRabbit). That soundness is CONTINGENT
  // on the two constants staying equal and the cap staying structural; if
  // either ever changes independently, revisit this filter's ordering.
  const sessions = (await listSessions({ ownerId: userId })).filter(
    (session) => session.sessionId !== excludeWorkspaceSessionId,
  );
  if (sessions.length === 0) return [];

  const workersBySession = await listSessionConversationsBulk(sessions.map((s) => s.sessionId));

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

  return sessions.map((session) => ({
    workspaceId: session.sessionId,
    name: session.name,
    driveId: session.driveId,
    sandbox: session.sandboxStatus,
    workers: (workersBySession.get(session.sessionId) ?? []).map((worker) => ({
      sessionId: worker.conversationId,
      name: worker.title ?? '',
      agent:
        worker.agentPageId !== null
          ? { agentId: worker.agentPageId, title: agentTitles.get(worker.agentPageId) ?? '' }
          : null,
    })),
  }));
}

async function readSessionTranscript(input: {
  sessionId: string;
  agentPageId: string | null;
  limit: number;
}): Promise<TranscriptEntry[]> {
  if (input.agentPageId === null) {
    const rows = await db
      .select({ role: globalMessages.role, content: globalMessages.content, createdAt: globalMessages.createdAt })
      .from(globalMessages)
      .where(and(eq(globalMessages.conversationId, input.sessionId), eq(globalMessages.isActive, true)))
      .orderBy(desc(globalMessages.createdAt))
      .limit(input.limit);
    return rows
      .reverse()
      .map((row) => ({
        role: row.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: row.content,
        at: row.createdAt,
      }));
  }
  const rows = await db
    .select({
      role: chatMessages.role,
      content: chatMessages.content,
      createdAt: chatMessages.createdAt,
      status: chatMessages.status,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.pageId, input.agentPageId),
        eq(chatMessages.conversationId, input.sessionId),
        eq(chatMessages.isActive, true),
      ),
    )
    .orderBy(desc(chatMessages.createdAt))
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
  if (existing) return { ok: true, session: existing };

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
      sessionId: 'about-to-be-minted',
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
  | { ok: true; workspaceSessionId: string; unwind: (() => Promise<void>) | null }
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
    return { ok: true, workspaceSessionId: resolved.session.id, unwind: null };
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
    const access = await checkAccessForSubject(ownerId, { sessionId: 'about-to-be-minted', ownerId, driveId });
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
          workspaceSessionId: spawned.session.id,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      });
    };
    return { ok: true, workspaceSessionId: spawned.session.id, unwind };
  }

  // An existing workspaceId, gated by the ONE session access decision
  // (`checkSessionAccess` — owner or drive member).
  const access = await checkSessionAccess(ownerId, workspace);
  if (!access.allowed) {
    // Missing, foreign, and not-a-member all read identically — an
    // id-guessing caller learns nothing.
    return { ok: false, reason: 'workspace_not_found', detail: `There is no workspace "${workspace}" you can use. Call list_sessions to see yours.` };
  }
  return { ok: true, workspaceSessionId: workspace, unwind: null };
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
  workspaceSessionId: string,
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
      workspaceSessionId,
      error: lookupError instanceof Error ? lookupError.message : String(lookupError),
    });
  }
  if (boundAfterThrow?.id === workspaceSessionId) return 'bound';
  if (!verificationFailed) {
    // Confirmed unbound — safe to unwind the empty workspace.
    await unwind();
  }
  // Verification itself failed: leave the workspace alone rather than gamble
  // — a stray, empty, endable-by-hand workspace is cheap and recoverable;
  // wrongly killing one a worker is bound to is not.
  return 'not_bound';
}

export function buildSessionToolsDeps(): SessionToolsDeps {
  return {
    findOwnWorkspace: async (conversationId) => {
      const row = await findSessionForConversation(conversationId);
      return row ? { sessionId: row.id } : null;
    },
    listSessionWorkers,
    listOwnWorkspaces,

    findSession: async (sessionId) => {
      // The tool family's "sessionId" is the WORKER's conversation id (what
      // spawn returned) — resolve the conversation, not a workspace row.
      const conversation = await conversationRepository.getConversation(sessionId);
      if (!conversation) return null;
      // A history-deleted worker is not addressable. Load-bearing now that
      // `openOwnSession` authorizes by the RESOURCE alone (ownership +
      // bound + not closed) rather than by workspace membership — the old
      // workspace comparison incidentally masked deleted rows.
      if (!conversation.isActive) return null;
      return {
        sessionId,
        ownerId: conversation.userId,
        agentPageId: conversation.type === 'page' ? conversation.contextId : null,
        name: conversation.title ?? '',
        // A worker conversation never "ends" — its session might, which the
        // dispatch surfaces as a failed run rather than a dead address.
        endedAt: null,
        // The WORKSPACE this conversation is bound to (conversations.sessionId
        // — the agent_sessions.id FK), or null for a session-less thread.
        // `openOwnSession` requires it non-null (a plain thread is not a
        // worker) but no longer compares it to the caller's own workspace —
        // worker verbs are resource-addressed (issue #2335 product decision).
        workspaceSessionId: conversation.sessionId,
        // The human closed this conversation's LISTING (it no longer shows in
        // their sidebar) — `openOwnSession` refuses on this, so a worker verb
        // can never dispatch new work into, read, or kill a worker the user
        // has already closed.
        isClosed: conversation.closedInSessionAt !== null,
      };
    },

    countSessionConversations: async (workspaceSessionId) => {
      const [row] = await db
        .select({ n: count() })
        .from(conversations)
        .where(
          and(
            eq(conversations.sessionId, workspaceSessionId),
            eq(conversations.isActive, true),
            // Mirrors the HTTP creation path's cap count (create-conversation-
            // in-session.ts): a closed listing frees its cap slot here too, or
            // the tool-side spawn planner keeps refusing a replacement worker
            // for a slot the human already closed.
            isNull(conversations.closedInSessionAt),
          ),
        );
      return row?.n ?? 0;
    },

    canUseAgent: async (userId, agentPageId) => {
      const page = await db.query.pages.findFirst({
        where: and(eq(pages.id, agentPageId), eq(pages.type, 'AI_CHAT'), eq(pages.isTrashed, false)),
        columns: { id: true },
      });
      if (!page) return false;
      return canUserViewPage(userId, agentPageId);
    },

    createWorkerSession: async ({ sessionId, callerConversationId, ownerId, agentPageId, name, workspace }) => {
      const placement = await resolveWorkerPlacement({ workspace, callerConversationId, ownerId, agentPageId });
      if (!placement.ok) return placement;
      const { workspaceSessionId, unwind } = placement;

      try {
        await createConversationInSession({
          conversationId: sessionId,
          userId: ownerId,
          agentPageId,
          sessionId: workspaceSessionId,
          // The worker's label, written AT BIRTH onto the conversation row —
          // it is what the sidebar and list_sessions display (codex review,
          // P2: the old path reported the name in the tool response and then
          // discarded it).
          title: name,
        });
      } catch (error) {
        if (unwind) {
          const recovered = await recoverMintedWorkspaceAfterThrow(sessionId, workspaceSessionId, unwind);
          if (recovered === 'bound') return { ok: true, workspaceSessionId };
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
          sessionId,
          callerConversationId,
          ownerId,
          ...(cause ? { cause: `${cause.name}: ${cause.message}` } : {}),
        });
        return { ok: false, reason: 'conversation_unavailable', detail: 'That conversation id is not available.' };
      }
      return { ok: true, workspaceSessionId };
    },

    dispatch: dispatchThroughChatPipeline,

    readTranscript: readSessionTranscript,

    endSession: async ({ sessionId, userId }) => {
      // Stop the worker's in-flight run (the caller's own streams only —
      // abortConversationStreams' authorization). Deliberately NO sandbox
      // teardown: a worker works in its SPAWNER's session, so tearing "its"
      // sandbox down would destroy the caller's own working context.
      await abortConversationStreams({ conversationId: sessionId, userId }).catch(() => {});
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

    spawnShell: async ({ sessionId, ownerId, name }) => {
      // The pure layer hands the CALLER's conversation id; shells hang off the
      // SESSION, so resolve the working context first.
      const session = await findSessionForConversation(sessionId);
      if (!session) return { ok: false, reason: 'no_session' };
      const spawned = await spawnShell({ sessionId: session.id, ownerId, name });
      if (!spawned.ok) return { ok: false, reason: spawned.reason };
      return { ok: true, shell: spawned.shell };
    },

    findShell: async (shellId) => {
      const store = await getSessionShellStore();
      const row = await store.findById(shellId);
      if (!row) return null;
      return {
        shellId: row.id,
        sessionId: row.sessionId,
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
