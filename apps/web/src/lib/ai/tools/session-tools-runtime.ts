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
import { and, eq, ne, desc, inArray } from '@pagespace/db/operators';
import { chatMessages, pages } from '@pagespace/db/schema/core';
import { messages as globalMessages } from '@pagespace/db/schema/conversations';
import { users } from '@pagespace/db/schema/auth';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { getCodeExecutionConcurrencyLimit } from '@pagespace/lib/services/sandbox/quota';
import { toSubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { deriveSandboxStatus } from '@pagespace/lib/services/agent-sessions/session-status';
import {
  ensureSession,
  provisionSessionSandbox,
  endSession as endSessionRuntime,
  getAgentSessionStore,
  findSessionRecord,
} from '@/lib/agent-sessions/agent-sessions-runtime';
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
  type SessionListingEntry,
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
 *     at an attacker-chosen origin. The configured URL is validated at boot
 *     (`env-validation.ts`) and cannot be influenced per-request.
 *
 * Same precedence as every other self-URL consumer in the repo (see
 * `services/email-service.ts`): `WEB_APP_URL`, then `NEXT_PUBLIC_APP_URL`.
 */
export function resolveSelfBaseUrl(): string | null {
  const configured = process.env.WEB_APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!configured) return null;
  const normalized = configured.replace(/\/$/, '');
  // Absolute-URL guard: a relative or malformed value would otherwise turn the
  // dispatch URL into a same-process path that never reaches the route.
  try {
    new URL(normalized);
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
    return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) };
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

async function listSessionsForOwner(ownerId: string): Promise<SessionListingEntry[]> {
  const store = await getAgentSessionStore();
  const rows = await store.list({ ownerId });
  const agentIds = [...new Set(rows.flatMap((row) => (row.agentPageId ? [row.agentPageId] : [])))];
  const agentTitles = new Map<string, string>(
    agentIds.length === 0
      ? []
      : (
          await db
            .select({ id: pages.id, title: pages.title })
            .from(pages)
            .where(inArray(pages.id, agentIds))
        ).map((page) => [page.id, page.title]),
  );

  return Promise.all(
    rows.map(async (row) => ({
      sessionId: row.conversationId,
      name: row.name ?? '',
      status: deriveSandboxStatus(row),
      agent:
        row.agentPageId === null
          ? null
          : { agentId: row.agentPageId, title: agentTitles.get(row.agentPageId) ?? 'Agent' },
      shells: (await listShells(row.conversationId)).map((shell) => ({
        shellId: shell.shellId,
        name: shell.name,
        createdAt: shell.createdAt,
      })),
    })),
  );
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

export function buildSessionToolsDeps(): SessionToolsDeps {
  return {
    listSessions: listSessionsForOwner,

    findSession: async (sessionId) => {
      const row = await findSessionRecord(sessionId);
      if (!row) return null;
      return {
        sessionId: row.conversationId,
        ownerId: row.ownerId,
        agentPageId: row.agentPageId,
        name: row.name ?? '',
        endedAt: row.endedAt?.toISOString() ?? null,
      };
    },

    countActiveSessions: async (ownerId) => {
      const store = await getAgentSessionStore();
      const rows = await store.list({ ownerId });
      // "Live" = holding a VM right now: a torn-down or never-provisioned row
      // costs nothing and must not count against the compute quota.
      return rows.filter((row) => row.sandboxId !== null && row.spriteTornDownAt === null && row.endedAt === null)
        .length;
    },

    concurrencyLimit: async (ownerId) => {
      const [row] = await db
        .select({ subscriptionTier: users.subscriptionTier })
        .from(users)
        .where(eq(users.id, ownerId))
        .limit(1);
      return getCodeExecutionConcurrencyLimit(toSubscriptionTier(row?.subscriptionTier));
    },

    canUseAgent: async (userId, agentPageId) => {
      const page = await db.query.pages.findFirst({
        where: and(eq(pages.id, agentPageId), eq(pages.type, 'AI_CHAT'), eq(pages.isTrashed, false)),
        columns: { id: true },
      });
      if (!page) return false;
      return canUserViewPage(userId, agentPageId);
    },

    createWorkerSession: async ({ sessionId, ownerId, agentPageId, name }) => {
      const ensured = await ensureSession({ conversationId: sessionId, userId: ownerId, agentPageId, name });
      if (!ensured.ok) return { ok: false, reason: ensured.reason, detail: ensured.detail };
      return { ok: true };
    },

    dispatch: dispatchThroughChatPipeline,

    readTranscript: readSessionTranscript,

    endSession: async ({ sessionId, userId }) => {
      // Stop any in-flight run FIRST (the caller's own streams only —
      // abortConversationStreams' authorization), then release the compute.
      await abortConversationStreams({ conversationId: sessionId, userId }).catch(() => {});
      const ended = await endSessionRuntime(sessionId);
      if (!ended.ok) return { ok: false, reason: ended.reason };
      return { ok: true, spriteTornDown: ended.spriteTornDown };
    },

    ensureOwnSessionSandbox: async ({ conversationId, userId, agentPageId }) => {
      const ensured = await ensureSession({ conversationId, userId, agentPageId });
      if (!ensured.ok) {
        return { ok: false, error: `Could not open this conversation's session (${ensured.reason}).` };
      }
      const provisioned = await provisionSessionSandbox(ensured.session, userId);
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
      const spawned = await spawnShell({ sessionId, ownerId, name });
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
