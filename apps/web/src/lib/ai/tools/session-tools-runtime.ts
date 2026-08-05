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
 * The dispatch acts as the CALLER: it forwards the live request's own
 * credentials (cookie/Bearer/origin via `next/headers`) and, for cookie
 * sessions, MINTS a fresh CSRF token bound to that server-validated session —
 * so the worker acts as the same user who asked for it, through the same
 * admission control (credit gate, takeover discipline) the interactive path
 * runs. The chain depth rides the
 * `X-Agent-Dispatch-Depth` header, which both chat routes fold back into
 * `agentCallDepth` so the pure depth cap keeps terminating across the hop.
 */

import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, count, eq, isNull, ne, desc } from '@pagespace/db/operators';
import { chatMessages, pages } from '@pagespace/db/schema/core';
import { conversations, messages as globalMessages } from '@pagespace/db/schema/conversations';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { generateCSRFToken } from '@pagespace/lib/auth/csrf-utils';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { deriveSandboxStatus } from '@pagespace/lib/services/agent-sessions/session-status';
import { getSessionFromCookies } from '@/lib/auth/cookie-config';
import {
  createConversationInSession,
  ensureGlobalSandboxSession,
  findSessionForConversation,
  provisionSessionSandbox,
  getAgentSessionStore,
} from '@/lib/agent-sessions/agent-sessions-runtime';
import {
  ConversationUnavailableError,
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
  type SessionWorkspaceListing,
  type SessionToolsDeps,
  type TranscriptEntry,
} from './session-tools';
import { createShellIo, realtimeShellIoTransport } from './shell-io';

// ---------------------------------------------------------------------------
// Worker dispatch through the standard chat pipeline
// ---------------------------------------------------------------------------

/**
 * The headers the dispatch forwards verbatim — the caller's own credentials.
 *
 * `authorization` matters as much as `cookie`: desktop/mobile/MCP callers
 * authenticate with a Bearer token, carry no CSRF token, and often send a
 * cookie anyway (`credentials: 'include'`). Dropping their Bearer credential
 * degraded the hop to cookie-only session auth, which the chat routes rightly
 * refuse with "CSRF token required" (issue #2333).
 */
const FORWARDED_HEADERS = ['cookie', 'x-csrf-token', 'origin', 'referer', 'authorization'] as const;

/**
 * A fresh CSRF token for the internal hop, bound to the caller's
 * server-validated cookie session — the exact binding `validateCSRF` checks on
 * the receiving route. Minting (rather than replaying the browser's token)
 * keeps cookie-session dispatches working when the caller's own token is
 * absent (the route admitted them without one) or older than the 1-hour TTL
 * (an agent turn can outlive it) — issue #2333. This is a credential FOR the
 * caller's own session, not a bypass: no valid session cookie, no token, and
 * nothing here consults any attacker-suppliable header.
 *
 * Bearer hops return null: Bearer auth is CSRF-immune at the route layer, and
 * `authenticateSessionRequest` resolves Bearer before cookie, so the minted
 * token would bind to a session the route never looks at. The check mirrors
 * `getBearerToken`'s `Bearer ` prefix test exactly — a non-Bearer
 * Authorization header (e.g. a fronting proxy's `Basic …`) does NOT exempt
 * the hop from CSRF at the route, so it must not suppress the mint here.
 */
async function mintDispatchCSRFToken(incoming: Headers): Promise<string | null> {
  if (incoming.get('authorization')?.startsWith('Bearer ')) return null;
  const sessionToken = getSessionFromCookies(incoming.get('cookie'));
  if (!sessionToken) return null;
  try {
    const claims = await sessionService.validateSession(sessionToken, { expectedType: 'user' });
    if (!claims) return null;
    return generateCSRFToken(claims.sessionId);
  } catch (error) {
    // Transient session-store failure or missing CSRF_SECRET — degrade, never
    // throw a raw internal error out of a tool (issue #2262 finding 3). The
    // forwarded browser token (if any) is still sent, so the route gives its
    // own honest answer.
    loggers.ai.error('session dispatch: could not mint a CSRF token for the internal hop', error instanceof Error ? error : undefined);
    return null;
  }
}

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
export async function dispatchThroughChatPipeline(input: {
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
  if (!incoming.get('cookie') && !incoming.get('authorization')) {
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
  const mintedCSRFToken = await mintDispatchCSRFToken(incoming);
  if (mintedCSRFToken) requestHeaders['x-csrf-token'] = mintedCSRFToken;

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
  | { ok: false; reason: 'no_session' | 'session_limit_reached' };

/**
 * Resolve the SESSION a worker would join for a caller conversation — a
 * worker works in its SPAWNER's workspace: same session, same sandbox, same
 * filesystem; that shared context is the point of spawning one.
 *
 * No caller session ⇒ refusal, never a lazily-minted per-thread environment
 * (the conflation the session model removed) — with the ONE exception the
 * sandbox acquire path already carved out (`resolveOrProvisionSession` in
 * sandbox-tools-runtime): a GLOBAL conversation is always minted session-less
 * and nothing else ever claims it, so it gets the same spawn+claim its first
 * sandbox tool call would trigger. Without this, a deployment where no
 * sandbox tool exists to run that acquire path (compute kill-switch off)
 * advertises spawn_session that can never succeed (review #2326).
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
  if (conversation?.type !== 'global') return { ok: false, reason: 'no_session' };

  const ensured = await ensureGlobalSandboxSession(callerConversationId, ownerId);
  if (ensured.ok) return { ok: true, session: ensured.session };
  return {
    ok: false,
    reason: ensured.reason === 'session_limit_reached' ? 'session_limit_reached' : 'no_session',
  };
}

export function buildSessionToolsDeps(): SessionToolsDeps {
  return {
    findOwnWorkspace: async (conversationId) => {
      const row = await findSessionForConversation(conversationId);
      return row ? { sessionId: row.id } : null;
    },
    listSessionWorkers,

    findSession: async (sessionId) => {
      // The tool family's "sessionId" is the WORKER's conversation id (what
      // spawn returned) — resolve the conversation, not a workspace row.
      const conversation = await conversationRepository.getConversation(sessionId);
      if (!conversation) return null;
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
        // Compared against the CALLER's own workspace in openOwnSession
        // (issue #2262 finding 1): ownership of the row alone is not enough,
        // because a user's own conversation in a DIFFERENT session must still
        // refuse — exactly what shells already enforce via findOwnWorkspace.
        workspaceSessionId: conversation.sessionId,
        // The human closed this conversation's LISTING (it no longer shows in
        // their sidebar) — `openOwnSession` refuses on this the same way it
        // refuses a foreign workspace, so a worker verb can never dispatch new
        // work into, read, or kill a sibling the user has already closed.
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

    createWorkerSession: async ({ sessionId, callerConversationId, ownerId, agentPageId, name }) => {
      const resolved = await resolveCallerSessionForWorker(callerConversationId, ownerId);
      if (!resolved.ok) {
        return resolved.reason === 'session_limit_reached'
          ? { ok: false, reason: 'session_limit_reached', detail: 'You are at your active-session limit — end an existing session first.' }
          : { ok: false, reason: 'no_session', detail: 'This conversation has no session for a worker to join.' };
      }
      const callerSession = resolved.session;
      try {
        await createConversationInSession({
          conversationId: sessionId,
          userId: ownerId,
          agentPageId,
          sessionId: callerSession.id,
          // The worker's label, written AT BIRTH onto the conversation row —
          // it is what the sidebar and list_sessions display (codex review,
          // P2: the old path reported the name in the tool response and then
          // discarded it).
          title: name,
        });
      } catch (error) {
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
        if (!(error instanceof ConversationUnavailableError)) {
          loggers.ai.error('createWorkerSession: could not create the worker conversation', error instanceof Error ? error : undefined, { sessionId, callerConversationId, ownerId });
        }
        return { ok: false, reason: 'conversation_unavailable', detail: 'That conversation id is not available.' };
      }
      return { ok: true };
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
