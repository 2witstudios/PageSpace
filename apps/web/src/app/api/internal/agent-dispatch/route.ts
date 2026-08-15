/**
 * POST /api/internal/agent-dispatch
 *
 * A worker verb (`spawn_session` / `send_session`) delivering one turn into a
 * worker's conversation.
 *
 * SERVER-TO-SERVER ONLY. There is no user session on this request — the caller
 * is this same app, running a tool for an actor it has already authorized in the
 * tool layer. It proves that with an HMAC over the raw body, the same signature
 * `/api/broadcast`, `/api/realtime/attach` and `/api/internal/voice/bridge` use,
 * verified BEFORE the body is parsed. The acting user id is then taken from the
 * signed payload and every downstream permission check runs against it — a valid
 * signature authenticates the SERVICE, never the user, so nothing below treats it
 * as authorization for a particular person's data.
 *
 * WHY THIS ROUTE EXISTS. Dispatch used to POST `/api/ai/chat` while REPLAYING the
 * calling user's cookie/Bearer, which made a live browser-ish credential a
 * precondition for one agent messaging another. Every server-side surface — the
 * voice bridge, cron, the workflow executor, the mention responder — has none by
 * construction and was refused outright. Signing instead of borrowing removes
 * that precondition, and with it the CSRF-minting machinery and the forwarded-
 * cookie surface that came with replay.
 *
 * IT DOES NOT RE-DECIDE THE STRATEGY. It calls `dispatchChatTurn`, the same
 * decision `handleChatTurn` reaches after authenticating a public request, so a
 * dispatched turn and a browser turn can never diverge on which strategy a
 * conversation gets.
 *
 * ONE DELIBERATE WIDENING over the public page URL. `POST /api/ai/chat` re-refuses
 * an MCP token that resolves to a global-assistant conversation, because that URL
 * is addressable by untrusted bearer clients naming an arbitrary conversation id.
 * A dispatch is not that: the tool layer already resolved the target and
 * authorized this actor against it, and the payload is signed. So a chain that
 * STARTED at an MCP token can reach a global worker here — which is what lets the
 * SDK and CLI talk to the global assistant — while `dispatchChatTurn`'s own
 * `conversation.userId === auth.userId` check still gates who that may be.
 *
 * NOT rate-limited or credit-gated here: the turn it delivers runs through the
 * standard pipeline, which gates and meters it exactly as it would a human's.
 */

import { NextResponse } from 'next/server';
import {
  AGENT_DISPATCH_SIGNATURE_HEADER,
  parseSignedAgentDispatch,
} from '@pagespace/lib/auth/agent-dispatch-payload';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { loadServicePrincipal } from '@/lib/auth';
import { dispatchChatTurn } from '@/lib/ai/chat-pipeline/handle-chat-turn';
import { AGENT_DISPATCH_DEPTH_HEADER } from '@/lib/ai/core/agent-dispatch-depth';

export const maxDuration = 300;

/**
 * A turn's text, capped so a caller that can sign cannot make us buffer an
 * arbitrary body. Matches the chat pipeline's own 25MB ceiling rather than the
 * voice bridge's 256KB: this body carries a user message, which may legitimately
 * be large.
 */
const MAX_BODY_BYTES = 25 * 1024 * 1024;

/** One refusal for every authentication failure — see `parseSignedAgentDispatch`. */
function refused(): NextResponse {
  return NextResponse.json({ error: 'Authentication failed' }, { status: 401 });
}

export async function POST(request: Request) {
  const rawBody = await request.text();

  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Request body too large (max 25MB)' }, { status: 413 });
  }

  const parsed = parseSignedAgentDispatch(
    request.headers.get(AGENT_DISPATCH_SIGNATURE_HEADER),
    rawBody,
  );
  if (!parsed.ok) {
    loggers.ai.warn('agent dispatch: request rejected', { reason: parsed.reason });
    return refused();
  }

  const payload = parsed.payload;

  // The signature proved the SERVICE. This proves nothing about the user — it
  // READS the user, live, so suspension and role changes bind on this hop rather
  // than on whenever the signer last looked.
  const auth = await loadServicePrincipal({
    userId: payload.actingUserId,
    service: 'agent-dispatch',
    allowedDriveIds: payload.allowedDriveIds,
    originatingMcpTokenId: payload.originatingMcpTokenId,
  });
  if (!auth) {
    loggers.ai.warn('agent dispatch: acting user could not be resolved', {
      conversationId: payload.conversationId,
    });
    return refused();
  }

  // Depth comes from the SIGNED payload, and the header is rebuilt from it —
  // never read off the wire here. `readAgentDispatchDepth` still does the reading
  // downstream (one parse, one clamp, unchanged), but on this path the value it
  // reads is one we authenticated, so the recursion cap cannot be reset by a
  // forged header on an internal hop.
  const pipelineRequest = new Request(request.url, {
    method: 'POST',
    headers: { [AGENT_DISPATCH_DEPTH_HEADER]: String(payload.depth) },
  });

  return dispatchChatTurn({
    request: pipelineRequest,
    auth,
    browserSessionId: payload.browserSessionId,
    body: {
      ...(payload.chatId !== null ? { chatId: payload.chatId } : {}),
      conversationId: payload.conversationId,
      messages: [
        { id: payload.messageId, role: 'user', parts: [{ type: 'text', text: payload.text }] },
      ],
    },
    // The page surface's strategy selection is the one that resolves a global
    // conversation from its id — the same path dispatch has always targeted.
    surface: 'page-chat',
  });
}
