/**
 * THE SIGNED BODY OF AN INTERNAL WORKER DISPATCH.
 *
 * When a worker verb (`spawn_session` / `send_session`) delivers a turn, it hops
 * back into this app over HTTP so the generation runs in a FRESH invocation and
 * outlives the caller's — that is what makes `wait: false` fire-and-forget work
 * (`ai_stream_sessions` owns the stream, not the HTTP reader).
 *
 * That hop used to authenticate by REPLAYING the calling user's cookie or Bearer
 * out of `next/headers`, which meant only a live browser-ish request could
 * dispatch at all. Every server-side surface — the voice bridge, cron, the
 * workflow executor, the channel mention responder — has no such credential by
 * construction and got a flat refusal ("the calling request carries no session
 * credentials to dispatch with"). This module replaces the borrowed credential
 * with one of dispatch's own.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE SIGNATURE PROVES, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 *
 * It proves THE SERVICE, never the user — the same property, and the same HMAC,
 * that `/api/broadcast`, `/api/realtime/attach`, and `/api/internal/voice/bridge`
 * already run on. `REALTIME_BROADCAST_SECRET` therefore already confers
 * act-as-any-user inside this app; this is not a new trust boundary, and holding
 * that secret is holding the keys regardless of this module.
 *
 * Consequently the payload carries NO privilege claims: no role, no
 * tokenVersion, no membership. It names an actor and a CEILING. The receiving
 * route re-reads the user row (`loadServicePrincipal`) and fails closed on
 * suspension, so the signer can never assert what a user may do — only which
 * user, and at most how far.
 *
 * REPLAY: the HMAC covers the whole raw body, so actor, conversation and depth
 * are bound to each other and to the 5-minute timestamp window. A replay inside
 * that window therefore replays THE SAME turn into THE SAME conversation at THE
 * SAME depth — a duplicate, never an escalation. There is deliberately no nonce
 * store: an attacker able to replay already holds the secret and can simply sign
 * a fresh dispatch, so a nonce table would buy storage and a false sense of a
 * boundary that is not there.
 */

import { z } from 'zod';
import {
  formatSignatureHeader,
  generateBroadcastSignature,
  verifyBroadcastSignature,
} from './broadcast-auth';

/** The header the signature travels in — the same one every other signed internal hop uses. */
export const AGENT_DISPATCH_SIGNATURE_HEADER = 'x-broadcast-signature';

export const agentDispatchPayloadSchema = z.object({
  /** Bumped only for a wire-incompatible change; the route refuses anything else. */
  v: z.literal(1),
  /** WHO the turn runs as. Every downstream permission check resolves against this id. */
  actingUserId: z.string().min(1),
  /** The worker's conversation. */
  conversationId: z.string().min(1),
  /** The agent page for a page worker; `null` for a global-assistant worker. */
  chatId: z.string().min(1).nullable(),
  /**
   * The agent-call depth this turn runs AT. Signed, so the recursion cap cannot
   * be reset by an attacker-suppliable header — the route re-emits it onto the
   * request it hands the pipeline and ignores whatever arrived on the wire.
   */
  depth: z.number().int().min(0),
  /** The originating credential's drive ceiling; `[]` = no ceiling. See `getAllowedDriveIds`. */
  allowedDriveIds: z.array(z.string()),
  /** Present when the chain started at a scoped MCP token, so its RBAC ceiling survives the hop. */
  originatingMcpTokenId: z.string().optional(),
  /** The synthetic `agent-dispatch-<cuid>` id; identifies this dispatch, not a browser tab. */
  browserSessionId: z.string().min(1),
  /** The user message this dispatch delivers. */
  messageId: z.string().min(1),
  text: z.string(),
});

export type AgentDispatchPayload = z.infer<typeof agentDispatchPayloadSchema>;

/**
 * Serialize and sign. Returns the EXACT body bytes that were signed — the caller
 * must POST `body` verbatim, because the HMAC covers the serialization, not the
 * object.
 */
export function signAgentDispatch(payload: AgentDispatchPayload): {
  body: string;
  signatureHeader: string;
} {
  const body = JSON.stringify(payload);
  const { timestamp, signature } = generateBroadcastSignature(body);
  return { body, signatureHeader: formatSignatureHeader(timestamp, signature) };
}

export type ParsedAgentDispatch =
  | { ok: true; payload: AgentDispatchPayload }
  | { ok: false; reason: 'bad_signature' | 'malformed' };

/**
 * Verify THEN parse — in that order, and over the RAW body.
 *
 * Parsing first would mean shaping attacker-controlled bytes before anything has
 * proved they came from us. The signature check is also the only place the
 * timestamp window is enforced, so it must not be reachable around.
 *
 * The two failure reasons are for LOGGING only. The route answers both with one
 * indistinguishable 401: a caller that cannot sign learns nothing about which
 * half of the check it failed.
 */
export function parseSignedAgentDispatch(
  signatureHeader: string | null,
  rawBody: string,
): ParsedAgentDispatch {
  if (!signatureHeader || !verifyBroadcastSignature(signatureHeader, rawBody)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const parsed = agentDispatchPayloadSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: 'malformed' };

  return { ok: true, payload: parsed.data };
}
