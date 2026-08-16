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
 * ONE DELIBERATE WIDENING over the public page URL, and a narrowing of its own.
 * `POST /api/ai/chat` re-refuses ANY MCP token that resolves to a
 * global-assistant conversation, because that URL is addressable by untrusted
 * bearer clients naming an arbitrary conversation id. A dispatch is not that: the
 * tool layer already resolved the target and authorized this actor against it,
 * and the payload is signed. So a chain that started at an UNSCOPED token can
 * reach a global worker here — which is what lets the SDK and CLI talk to the
 * global assistant — while `dispatchChatTurn`'s own
 * `conversation.userId === auth.userId` check still gates who that may be.
 *
 * A DRIVE-SCOPED credential is refused on that path outright (see the guard
 * below): the global strategy has no drive-scope machinery, and a global
 * conversation spans the whole account by definition, so there is nothing
 * coherent for a drive-confined credential to be doing there.
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
import { messageRepository } from '@/lib/repositories/message-repository';
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
  // Declared size FIRST, before buffering — the point of the cap is that a
  // caller who can sign cannot make us hold an arbitrary body in memory, and a
  // check that runs after `text()` has already resolved does not achieve that
  // (PR review). The public entry does the same, in the same order.
  const declaredLength = Number.parseInt(request.headers.get('content-length') || '0', 10);
  if (declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Request body too large (max 25MB)' }, { status: 413 });
  }

  const rawBody = await request.text();

  // BYTES, not UTF-16 code units: `String.length` counts units, so ~12.5MB of
  // multibyte text passes a 25MB `.length` test while being 25MB on the wire.
  // Kept as a second check because `content-length` is absent on a chunked
  // request and is in any case the caller's claim about itself.
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
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

  // A DRIVE-SCOPED credential may not drive a global-assistant worker.
  //
  // The global strategy has no drive-scope machinery at all — no
  // `filterToolsForMcpScope`, and an `experimental_context` that carries neither
  // `mcpAllowedDriveIds` nor `mcpTokenId` — because until this route existed no
  // scoped credential could reach it (`handle-chat-turn` refuses MCP tokens on
  // the public global path, and the global URL is session-only). Letting a
  // scoped dispatch through here would have silently handed the worker the
  // owner's full cross-drive reach, ceiling and all (PR review, P1).
  //
  // Refusing is the right answer rather than a stopgap: a global-assistant
  // conversation IS the user's whole account — it spans every drive by
  // definition — so a token confined to some drives has no coherent business
  // driving one. An UNSCOPED credential (a session, or a full-account token from
  // the SDK/CLI) carries no ceiling and still reaches global workers, which is
  // the case this epic set out to enable.
  if (payload.chatId === null && payload.allowedDriveIds.length > 0) {
    loggers.ai.warn('agent dispatch: scoped credential refused on a global-assistant worker', {
      conversationId: payload.conversationId,
    });
    return NextResponse.json(
      { error: 'A drive-scoped credential cannot drive a global-assistant worker.' },
      { status: 403 },
    );
  }

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

  // IDEMPOTENCE. The signature's 5-minute window bounds replay but does not
  // prevent it, and a replayed dispatch is not harmless: the user message
  // upserts on its id, but the turn would start a SECOND generation, mint a new
  // assistant message, and settle billing again (PR review).
  //
  // The payload's `messageId` is the idempotency key — it is signed, so a replay
  // necessarily carries the same one, and it is already written by the turn it
  // belongs to. If it exists, this dispatch was accepted before; answer as
  // though it succeeded rather than erroring, because from the caller's side it
  // did. Cluster-safe by construction (one shared table), unlike an in-process
  // nonce cache.
  //
  // Residual, and deliberately not papered over: two replays racing inside the
  // window can both read "absent" before either writes. Closing that needs a
  // unique-constrained claim row, which is a schema change; the signature — an
  // attacker holding the secret can sign a FRESH dispatch anyway — remains the
  // real boundary, and this removes the accidental and the cheap-replay cases.
  const alreadyDispatched = await messageRepository
    .getMessageById(payload.messageId)
    .catch(() => null);
  if (alreadyDispatched) {
    loggers.ai.warn('agent dispatch: ignoring a replayed dispatch', {
      conversationId: payload.conversationId,
      messageId: payload.messageId,
    });
    return NextResponse.json({ ok: true, replayed: true }, { status: 200 });
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
