/**
 * The web -> realtime handoff for a live OpenAI voice call.
 *
 * One payload crosses one process boundary, so — following the rule
 * `shells-contract` sets down — its schema is declared exactly once, here, and
 * both sides parse with it. The web tier builds the body; `apps/realtime`
 * validates it after the HMAC check and before touching a socket.
 *
 * WHY THE TOOLS TRAVEL IN THIS PAYLOAD. `apps/realtime` cannot build the
 * realtime tool definitions itself: the conversion (`buildRealtimeTools`) reads
 * PageSpace's AI SDK tool registry, which lives in `apps/web/src/lib/ai` behind
 * the `@/` alias, imports `ai`/`zod`, and has env-dependent branches. There is
 * no dependency edge from `apps/realtime` to `apps/web` and there must not be
 * one. So the side that owns the registry converts, and the wire shape below
 * carries the result. The browser is still never sent a tool schema — this is a
 * server-to-server hop, signed, on the internal network.
 *
 * The SECRET in this payload is a live OpenAI credential with ~60s of life and
 * the capability to attach to a real call. Every field below is on the wire
 * because the receiver cannot derive it; nothing extra is.
 *
 * Pure: schemas and constants only. No I/O, no clock, no randomness, no
 * module-level mutable state.
 */

import { z } from 'zod';

/**
 * Internal routes the web tier posts to on the realtime server. A single
 * declaration for the same reason `SHELL_BRIDGE_ROUTES` is one: a route string
 * written out per app is a route string that drifts per app.
 */
export const VOICE_BRIDGE_ROUTES = {
  attach: '/api/realtime/attach',
} as const;

/**
 * The three id spaces a realtime call runs on are NOT interchangeable, and the
 * one this payload carries is the CALL id. Measured shapes:
 * - `rtc_…`  — the call, returned in the `Location` header of `/v1/realtime/calls`
 * - `sess_…` — the session, returned by the mint
 * - `call_…` — one function call inside a response
 *
 * The prefix is checked here rather than trusted because `sess_…` is the id
 * sitting closest to hand at mint time, and attaching with it fails as an
 * opaque socket close rather than as a message anyone can read.
 */
export const REALTIME_CALL_ID_PREFIX = 'rtc_';

/**
 * OpenAI ephemeral client secrets are `ek_`-prefixed. Asserting the prefix is
 * what turns the single most confusing failure in this stack — passing the API
 * key (`sk-…`) where only that call's own ephemeral secret works — into a
 * refusal at the boundary with a name on it, instead of a bare `1006` socket
 * close ten seconds later.
 */
export const EPHEMERAL_SECRET_PREFIX = 'ek_';

export const realtimeCallIdSchema = z
  .string()
  .min(1)
  .startsWith(REALTIME_CALL_ID_PREFIX, 'callId must be an rtc_ call id');

export const ephemeralSecretSchema = z
  .string()
  .min(1)
  .startsWith(
    EPHEMERAL_SECRET_PREFIX,
    'secret must be the call\'s ephemeral client secret (ek_…), not an API key',
  );

/**
 * A tool as the realtime transport carries it: FLAT, not nested under a
 * `function` key the way Chat Completions nests them.
 *
 * This mirrors `RealtimeTool` in `apps/web/src/lib/ai/realtime/session.ts`. The
 * duplication is deliberate and bounded: that type is the web app's internal
 * shape, this is the validated wire shape, and the realtime server must not
 * import from the web app to learn it. A drift guard in the web tests asserts
 * the two agree.
 */
export const realtimeToolSchema = z.object({
  type: z.literal('function'),
  name: z.string().min(1),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
});

export type RealtimeToolWire = z.infer<typeof realtimeToolSchema>;

/**
 * What `POST /api/realtime/attach` receives.
 *
 * `conversationId` is optional because voice is a second transport onto a
 * conversation that may not exist yet at handshake time — a call that has not
 * been bound to a thread still attaches, still runs tools, and still meters.
 * Refusing to attach without one would make the binding state gate the call.
 */
export const realtimeAttachPayloadSchema = z.object({
  callId: realtimeCallIdSchema,
  secret: ephemeralSecretSchema,
  userId: z.string().min(1),
  conversationId: z.string().min(1).optional(),
  tools: z.array(realtimeToolSchema).default([]),
});

export type RealtimeAttachPayload = z.infer<typeof realtimeAttachPayloadSchema>;

/** What the attach endpoint answers. Never echoes the secret. */
export type RealtimeAttachResult =
  | { readonly success: true; readonly callId: string }
  | { readonly success: false; readonly error: string };
