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
 * The RETURN hop: routes `apps/realtime` posts back to on the web tier while a
 * call is live.
 *
 * This direction did not exist before voice — until now `apps/realtime` made no
 * outbound HTTP calls to web at all, and `docs/2.0-architecture/agent-sessions.md`
 * §3d said so while reasoning about deploy order. That statement is updated in
 * the same change that adds this, because it stops being true here.
 *
 * WHY IT HAS TO EXIST. The socket lives in `apps/realtime` (only a long-lived
 * process can hold a call for its whole life), but two of the things that
 * happen ON that socket are owned by `apps/web` and cannot move:
 *   - TOOL EXECUTION needs the AI SDK tool registry, its `@/`-aliased imports,
 *     and the permission functions the tools call INTO (`canActorViewPage`,
 *     `resolveActorAccessiblePagesInDrive`). Re-implementing any of that on the
 *     realtime side would be the second permission model this system must never
 *     grow.
 *   - TRANSCRIPT PERSISTENCE needs `messageRepository`, whose write is the same
 *     transaction that bumps `conversations.rev` and emits the `conversation:*`
 *     events every chat surface already subscribes to. A second writer would be
 *     a second owner of that invariant.
 *
 * METERING is deliberately NOT here. Its whole dependency set — `canConsumeAI`,
 * `AIMonitoring`, `calculateRealtimeCostDollars` — already lives in
 * `@pagespace/lib`, which `apps/realtime` depends on directly, so routing it
 * through an HTTP hop would add a failure mode and buy nothing. The rule is the
 * same one C-A applied to tools: the work runs where its owner lives.
 *
 * Signed with the SAME HMAC as the outbound direction (`REALTIME_BROADCAST_SECRET`
 * is symmetric), so the web route can prove the caller is the realtime server.
 */
export const VOICE_CALLBACK_ROUTES = {
  bridge: '/api/internal/voice/bridge',
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
 * Where the user is standing, as the tools need it.
 *
 * Mirrors the `locationContext` member of `ToolExecutionContext`
 * (`apps/web/src/lib/ai/core/types.ts`) — the same duplication trade as
 * `realtimeToolSchema` above, for the same reason, with the same drift guard.
 * It travels because a spoken "what's on this page?" is answerable only if the
 * dispatcher knows which page "this" is, and the realtime server is the only
 * party that can tell it: navigating mid-call updates this rather than
 * rebinding the session.
 */
export const voiceLocationContextSchema = z.object({
  currentPage: z
    .object({
      id: z.string(),
      title: z.string(),
      type: z.string(),
      path: z.string(),
      isTaskLinked: z.boolean().optional(),
    })
    .optional(),
  currentDrive: z
    .object({ id: z.string(), name: z.string(), slug: z.string() })
    .optional(),
  breadcrumbs: z.array(z.string()).optional(),
});

export type VoiceLocationContext = z.infer<typeof voiceLocationContextSchema>;

/**
 * One `conversation.item.create` message item, as the seed carries it.
 *
 * Typed exactly rather than as an opaque record because the two content-part
 * types are NOT interchangeable and getting them backwards fails silently:
 * a `role: 'user'` item takes `input_text`, a `role: 'assistant'` item takes
 * `text`, and the wrong one comes back as an opaque `error` event on a socket
 * that then just sits there. Mirrors `SeedEvent` in
 * `apps/web/src/lib/ai/realtime/seed.ts`, with a drift guard in the web tests.
 *
 * Assistant AUDIO is unrepresentable here on purpose — the Realtime API cannot
 * take it as history at all, which is the entire reason a seed is text.
 */
export const realtimeSeedEventSchema = z.object({
  type: z.literal('conversation.item.create'),
  item: z.object({
    type: z.literal('message'),
    role: z.enum(['user', 'assistant']),
    content: z
      .array(z.object({ type: z.enum(['input_text', 'text']), text: z.string() }))
      .min(1),
  }),
});

export type RealtimeSeedEventWire = z.infer<typeof realtimeSeedEventSchema>;

/**
 * WHO the caller is talking to, resolved server-side from the bound
 * conversation and carried for the life of the call.
 *
 * A voice call binds to a conversation that already exists, and a page
 * conversation's `contextId` IS its agent page — so "which assistant" is a
 * fact about the authorized conversation, never a claim the browser makes. It
 * travels because two things downstream cannot derive it:
 *
 *   - TOOL EXECUTION has to run as the agent, not merely as the person who
 *     started the call. `resolveActingAgentId` reads `chatSource.agentPageId`
 *     and every centralized `canActor*` check falls through to the invoking
 *     user's own (often broader) reach without it, so a page agent bound to a
 *     narrower ACL would silently borrow the caller's.
 *   - THE TOOL ALLOWLIST (`enabledTools`) is the agent owner's decision about
 *     what their agent may do. `undefined` means unrestricted, so omitting it
 *     is not a smaller claim than sending it — it is the largest one.
 *
 * `enabledTools` is nullable rather than optional because null is a real,
 * distinct value here: an agent with no allowlist configured is unrestricted,
 * and that has to be expressible without meaning "field absent, assume the
 * worst".
 *
 * ECHOING IT BACK on the tool hop adds no trust assumption. That hop already
 * carries `userId` under the same HMAC — anything able to forge this could
 * already claim to be any user, which is strictly more powerful than claiming
 * to be any agent.
 */
export const voiceAssistantSchema = z.object({
  agentPageId: z.string().min(1),
  agentTitle: z.string(),
  enabledTools: z.array(z.string()).nullable(),
});

export type VoiceAssistant = z.infer<typeof voiceAssistantSchema>;

/**
 * What `POST /api/realtime/attach` receives.
 *
 * `conversationId` is optional because voice is a second transport onto a
 * conversation that may not exist yet at handshake time — a call that has not
 * been bound to a thread still attaches, still runs tools, and still meters.
 * Refusing to attach without one would make the binding state gate the call.
 *
 * `model` and `subscriptionTier` ride along because the realtime server meters
 * the call itself and cannot derive either: the model is resolved from env at
 * the web edge (`resolveRealtimeModel`) and pricing is per-model, while the
 * tier was already read for the entitlement gate one function earlier and
 * re-reading it here would be a second DB round trip for a fact that cannot
 * change inside one call.
 *
 * `seed` is built web-side for the same reason `tools` is: it comes out of the
 * bound conversation's messages, behind a permission check, in the process that
 * owns the repositories. Shipping it in this payload rather than fetching it
 * over the return hop also keeps it off the critical path — the browser is
 * already in a call, and the seed must land before the model speaks.
 *
 * `instructions` and `assistant` come from the SAME authorized conversation
 * read as the seed, for the same reason: the agent's own `systemPrompt` and
 * `enabledTools` live in the web tier's tables, and the model is otherwise
 * handed the realtime default persona on a call the UI presents as talking to
 * a specific assistant. Both are optional because an unbound call is a real,
 * supported state — it has no assistant to be.
 */
export const realtimeAttachPayloadSchema = z.object({
  callId: realtimeCallIdSchema,
  secret: ephemeralSecretSchema,
  userId: z.string().min(1),
  conversationId: z.string().min(1).optional(),
  tools: z.array(realtimeToolSchema).default([]),
  model: z.string().min(1),
  subscriptionTier: z.string().min(1).default('free'),
  timezone: z.string().min(1).optional(),
  locationContext: voiceLocationContextSchema.optional(),
  seed: z.array(realtimeSeedEventSchema).default([]),
  instructions: z.string().min(1).optional(),
  assistant: voiceAssistantSchema.optional(),
});

export type RealtimeAttachPayload = z.infer<typeof realtimeAttachPayloadSchema>;

/* ------------------------------------------------------------------------- *
 * THE RETURN HOP — realtime -> web, for the life of the call.
 * ------------------------------------------------------------------------- */

/**
 * Run one tool the model asked for, with PageSpace's real registry and real
 * permissions, and give back something speakable.
 *
 * `argumentsJson` crosses as the RAW STRING the model produced, not as a parsed
 * object. That is deliberate: `function_call.arguments` arrives as a
 * newline-laden string that is not always valid JSON, and re-serializing a
 * half-parsed version of it here would move the parse failure to the wrong
 * side of the boundary — the dispatcher is where a malformed argument string
 * has to become a sentence the model can say.
 *
 * `timezone`, `locationContext` and `assistant` are echoed back rather than
 * looked up: the web tier holds no per-call state (a call is served by
 * whichever instance answers, and PROVEN FACT #2 is that per-call state cannot
 * live in one instance's memory), so the process that owns the call is the one
 * that remembers its context. `assistant` is what makes a tool run as the
 * bound agent instead of as the person who started the call — see
 * `voiceAssistantSchema` for why echoing it is not a new trust assumption.
 */
export const voiceToolDispatchSchema = z.object({
  kind: z.literal('tool'),
  callId: realtimeCallIdSchema,
  userId: z.string().min(1),
  conversationId: z.string().min(1).optional(),
  name: z.string().min(1),
  argumentsJson: z.string(),
  timezone: z.string().min(1).optional(),
  locationContext: voiceLocationContextSchema.optional(),
  assistant: voiceAssistantSchema.optional(),
});

/**
 * Write one spoken turn into the bound conversation as an ordinary message.
 *
 * `conversationId` is REQUIRED here where it is optional on the attach: an
 * unbound call still runs tools and still meters, but there is nowhere to
 * write its transcript, so the realtime side simply does not make this call.
 */
export const voiceTranscriptSchema = z.object({
  kind: z.literal('transcript'),
  callId: realtimeCallIdSchema,
  userId: z.string().min(1),
  conversationId: z.string().min(1),
  role: z.enum(['user', 'assistant']),
  text: z.string().min(1),
});

export const voiceBridgeRequestSchema = z.discriminatedUnion('kind', [
  voiceToolDispatchSchema,
  voiceTranscriptSchema,
]);

/**
 * The union, and only the union. Per-member aliases were exported alongside it
 * and never imported anywhere — every consumer takes the whole request and
 * narrows on `kind`, which is what a discriminated union is for. Re-add one
 * only when something actually needs to name a single member.
 */
export type VoiceBridgeRequest = z.infer<typeof voiceBridgeRequestSchema>;

/**
 * What the bridge answers.
 *
 * A tool result is ALWAYS a string — `function_call_output.output` must be one,
 * and a shape that could return an object would invite a caller to hand the
 * socket something the model rejects.
 */
export type VoiceBridgeResponse =
  | { readonly ok: true; readonly kind: 'tool'; readonly output: string }
  | {
      readonly ok: true;
      readonly kind: 'transcript';
      readonly saved: boolean;
      readonly messageId: string | null;
      readonly rev: number;
    }
  | { readonly ok: false; readonly error: string };

/** What the attach endpoint answers. Never echoes the secret. */
export type RealtimeAttachResult =
  | { readonly success: true; readonly callId: string }
  | { readonly success: false; readonly error: string };
