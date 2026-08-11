/**
 * The server-relay handshake: how a browser ends up in a WebRTC call with
 * OpenAI while OUR server — not the browser — holds the call's credential.
 *
 * The browser sends us an SDP offer and gets an SDP answer back. In between,
 * this module mints an ephemeral secret, relays the offer to OpenAI, reads the
 * call id out of the `Location` header, and hands both to the long-lived
 * realtime server over a signed internal request. The browser never contacts
 * `api.openai.com` and never holds a credential.
 *
 * WHY RELAY INSTEAD OF LETTING THE BROWSER POST DIRECTLY. `Location` is exposed
 * cross-origin (`access-control-expose-headers: Location, …`), so a direct
 * browser POST does work — that was measured, not assumed. We relay anyway
 * because the attach is authenticated by THAT CALL'S OWN ephemeral secret: a
 * fresh secret fails, and the API key fails with `404 call_id_not_found`. The
 * server has to hold the secret no matter what, so relaying is strictly LESS
 * machinery than the alternative — one route, the secret never enters the page,
 * and the call id arrives as a side effect of a request we already make.
 *
 * WHY THE MINT CARRIES NO TOOLS. `buildSessionConfig` is called with the model
 * and nothing else; the tool set is pushed later, by the realtime server, in
 * its own `session.update`. Minting the tools in as well would advertise them
 * to the model on a call that may never get a server attached (see the
 * `INTERNAL_REALTIME_URL` degrade path below) — the model would then try to
 * call tools with nobody listening. Tools arrive with the thing that executes
 * them, or not at all.
 *
 * Everything that touches the network arrives as a dependency, so the whole
 * handshake is testable without a live call.
 */

import {
  CLIENT_SECRETS_URL,
  REALTIME_CALLS_URL,
  SDP_CONTENT_TYPE,
  buildSessionConfig,
  extractClientSecret,
  type RealtimeTool,
} from './session';
import {
  REALTIME_CALL_ID_PREFIX,
  VOICE_BRIDGE_ROUTES,
  type RealtimeAttachPayload,
  type RealtimeSeedEventWire,
  type VoiceAssistant,
  type VoiceLocationContext,
} from '@pagespace/lib/realtime/voice-bridge-contract';

/**
 * Named failures. Every one of these is a distinct thing that went wrong at a
 * distinct hop, and each is named because the alternative — one "handshake
 * failed" — is what makes somebody re-debug this stack from scratch.
 *
 * `realtime_call_rejected` is the load-bearing one. `client_secrets` mints a
 * secret for ANY model string, including a model this account cannot use, so
 * mint success is not proof of model access: a bad `OPENAI_REALTIME_MODEL`
 * surfaces here and ONLY here, as a 403 `model_not_found` from
 * `/v1/realtime/calls`. That upstream body has to reach the caller intact or
 * the misconfiguration is invisible.
 *
 * `admission_refused` is the one failure that is not a malfunction. It means
 * the realtime server applied a POLICY — out of credit, or already on the
 * concurrency limit — and the call must not proceed. See `handOff`.
 */
export type HandshakeErrorCode =
  | 'mint_failed'
  | 'mint_missing_secret'
  | 'realtime_call_rejected'
  | 'missing_call_location'
  | 'malformed_call_location'
  | 'missing_answer_sdp'
  | 'admission_refused';

export type HandshakeFailure = {
  readonly ok: false;
  readonly code: HandshakeErrorCode;
  readonly message: string;
  /** Verbatim upstream error body, when the failure came from OpenAI. */
  readonly upstream?: unknown;
  readonly upstreamStatus?: number;
};

export type HandshakeSuccess = {
  readonly ok: true;
  readonly callId: string;
  readonly answerSdp: string;
  /**
   * Whether the realtime server took the call. `false` means the browser still
   * gets a working audio call with no server-side features — see `handOff`.
   */
  readonly attached: boolean;
};

export type HandshakeResult = HandshakeSuccess | HandshakeFailure;

/** Just enough logger to satisfy the call sites; the app's logger fits it. */
export type HandshakeLogger = {
  readonly warn: (message: string, meta?: Record<string, unknown>) => void;
  readonly error: (message: string, error: Error, meta?: Record<string, unknown>) => void;
};

export type HandshakeDeps = {
  readonly fetch: typeof fetch;
  /** The managed OpenAI key. Mints the secret; never attaches to a call. */
  readonly apiKey: string;
  /** Resolved by the caller from env — never defaulted inside this module. */
  readonly model: string;
  /** Realtime tool definitions, forwarded to the realtime server unchanged. */
  readonly tools: readonly RealtimeTool[];
  /**
   * The caller's tier, already read for the entitlement gate one function
   * earlier. Forwarded rather than re-read because the realtime server meters
   * the call and the credit gate needs it — and a tier cannot change inside one
   * call, so a second DB round trip would buy nothing.
   */
  readonly subscriptionTier: string;
  /** Unset means "no realtime server configured": degrade, do not fail. */
  readonly internalRealtimeUrl: string | undefined;
  /** `createSignedBroadcastHeaders`, injected so tests need no HMAC secret. */
  readonly signHeaders: (body: string) => Record<string, string>;
  readonly logger: HandshakeLogger;
};

export type HandshakeInput = {
  readonly offerSdp: string;
  readonly userId: string;
  readonly conversationId?: string;
  /**
   * The bound conversation's history, already loaded and capped
   * (`loadRealtimeSeed`). Built here rather than fetched by the realtime server
   * because the repositories and the access predicate live in this app — and
   * because the browser is already in a call by the time the handoff happens,
   * so the seed must arrive WITH it, not a round trip later.
   */
  readonly seed?: readonly RealtimeSeedEventWire[];
  /** Threaded into the tool-execution context the realtime server dispatches with. */
  readonly timezone?: string;
  readonly locationContext?: VoiceLocationContext;
  /**
   * What the model is told it is — the bound assistant's persona plus the
   * spoken-turn guidance. Resolved from the same authorized conversation read
   * as the seed.
   */
  readonly instructions?: string;
  /** The bound page agent, for tool execution. Absent for the Global Assistant. */
  readonly assistant?: VoiceAssistant;
};

/** Upstream calls are short; a hung one must not hold the request open. */
const OPENAI_TIMEOUT_MS = 15_000;

/**
 * The internal hop gets the same 5s ceiling the DM broadcast uses: an unhealthy
 * realtime server must not stall a handshake the browser is waiting on.
 */
const HANDOFF_TIMEOUT_MS = 5_000;

/** Read an error body without letting a non-JSON one throw over the real error. */
const readErrorBody = async (response: Response): Promise<unknown> => {
  const text = await response.text().catch(() => '');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/**
 * `Location` is a RELATIVE path (`/v1/realtime/calls/rtc_…`), so the call id is
 * its last segment. Query and fragment are stripped first, and the `rtc_`
 * prefix is asserted rather than assumed: returning an unvalidated last segment
 * is how an `undefined`/garbage call id gets all the way to a socket that then
 * closes with an unreadable `1006`.
 */
export const parseCallId = (location: string | null): string | undefined => {
  if (!location) return undefined;
  const path = location.split(/[?#]/)[0].replace(/\/+$/, '');
  const segment = path.slice(path.lastIndexOf('/') + 1);
  return segment.startsWith(REALTIME_CALL_ID_PREFIX) ? segment : undefined;
};

/**
 * What the handoff decided, and it is NOT one bit.
 *
 * `degraded` and `refused` look identical on the wire — both are a non-2xx from
 * the same endpoint — and collapsing them is what let a refused call keep
 * running: the browser already holds a valid answer SDP, so "we could not
 * attach" and "you may not have this call" both ended as `attached: false` and
 * the call went ahead unmetered.
 */
type HandoffOutcome =
  | { readonly kind: 'attached' }
  /** The tool/transcript/metering plane is unreachable. Degrade, do not fail. */
  | { readonly kind: 'degraded' }
  /** A policy said no: out of credit, or on the concurrency limit. */
  | { readonly kind: 'refused'; readonly status: number; readonly message: string };

/**
 * Statuses that mean POLICY rather than malfunction.
 *
 * 402 is the credit gate and 429 is a concurrency cap — the two admission
 * decisions `apps/realtime` takes BEFORE opening a socket, both of which exist
 * precisely so an unaffordable or over-limit call does not happen. Everything
 * else (a 400 from our own wire, a 502 from OpenAI's side of the attach) is a
 * malfunction in an optional plane, and the caller keeps a degraded call.
 */
const ADMISSION_REFUSAL_STATUSES = new Set([402, 429]);

/**
 * Hand the live call to the realtime server. Best-effort for OUTAGES by design:
 * at this point the browser has a valid answer SDP and can hold a working audio
 * call, so failing the handshake because the tool/transcript/metering plane is
 * unreachable would trade a degraded call for no call at all.
 *
 * NOT best-effort for REFUSALS. A 402 or a 429 is the credit gate or the
 * concurrency cap answering, and those gates only mean anything if the call
 * they refuse does not happen. Treated as a degrade they were worse than
 * absent: the browser kept a working OpenAI call that nothing was metering, so
 * a user out of credit got an unlimited one.
 */
const handOff = async (
  deps: HandshakeDeps,
  input: HandshakeInput,
  callId: string,
  secret: string,
): Promise<HandoffOutcome> => {
  if (!deps.internalRealtimeUrl) {
    deps.logger.warn(
      'Realtime voice call has no server attach: INTERNAL_REALTIME_URL is unset',
      { callId, userId: input.userId },
    );
    return { kind: 'degraded' };
  }

  // Signed, not merely internal. A valid HMAC proves the sender is the web
  // backend, and this body carries a live OpenAI credential — it must not be
  // the one unauthenticated internal endpoint.
  //
  // Typed as the shared contract, not as an inline literal: this is the one
  // place the sender's shape can be checked against what the receiver parses,
  // and a mismatch caught here is a compile error rather than a 400 from
  // another service.
  const payload: RealtimeAttachPayload = {
    callId,
    secret,
    userId: input.userId,
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    tools: [...deps.tools],
    model: deps.model,
    subscriptionTier: deps.subscriptionTier,
    ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
    ...(input.locationContext === undefined
      ? {}
      : { locationContext: input.locationContext }),
    seed: [...(input.seed ?? [])],
    ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    ...(input.assistant === undefined ? {} : { assistant: input.assistant }),
  };
  const body = JSON.stringify(payload);

  try {
    const response = await deps.fetch(
      `${deps.internalRealtimeUrl}${VOICE_BRIDGE_ROUTES.attach}`,
      {
        method: 'POST',
        headers: deps.signHeaders(body),
        body,
        signal: AbortSignal.timeout(HANDOFF_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      // The response body is read but NOT logged verbatim: it is the reply to a
      // request whose body held a secret, and nothing here is worth that risk.
      deps.logger.warn('Realtime server refused the call attach', {
        callId,
        userId: input.userId,
        status: response.status,
      });
      return ADMISSION_REFUSAL_STATUSES.has(response.status)
        ? {
            kind: 'refused',
            status: response.status,
            message:
              response.status === 402
                ? 'You do not have enough credit for a voice call.'
                : 'Too many voice calls are already running. Try again in a moment.',
          }
        : { kind: 'degraded' };
    }
    return { kind: 'attached' };
  } catch (error) {
    // An unreachable realtime server is an outage, not a refusal: nothing
    // decided anything about this call, so the caller keeps the degraded one.
    deps.logger.error(
      'Realtime server attach handoff failed',
      error instanceof Error ? error : new Error(String(error)),
      { callId, userId: input.userId },
    );
    return { kind: 'degraded' };
  }
};

/**
 * End a call we just created and are not going to use.
 *
 * Only reached when admission refused the call AFTER OpenAI had already
 * accepted it. Without this the refusal is only half enforced — the browser
 * holds an answer SDP for a live session, and our refusing to attach does not
 * end it.
 *
 * Never throws and never fails the caller: the refusal is the outcome being
 * reported, and a hangup that does not land degrades to "the call runs until
 * OpenAI's own timeout with nobody on it", which is strictly better than
 * turning a policy refusal into a 500.
 */
const abandonCall = async (
  deps: HandshakeDeps,
  callId: string,
  secret: string,
): Promise<void> => {
  try {
    await deps.fetch(`${REALTIME_CALLS_URL}/${encodeURIComponent(callId)}/hangup`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(HANDOFF_TIMEOUT_MS),
    });
  } catch (error) {
    deps.logger.warn('Could not hang up a realtime call that admission refused', {
      callId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
};

/**
 * Mint -> relay -> parse -> hand off. The secret exists only inside this
 * function's frame: it is never returned, never logged, and never persisted —
 * it lives ~60 seconds and the handoff is immediate.
 */
export const runCallHandshake = async (
  deps: HandshakeDeps,
  input: HandshakeInput,
): Promise<HandshakeResult> => {
  const mintResponse = await deps.fetch(CLIENT_SECRETS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${deps.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildSessionConfig({ model: deps.model })),
    signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
  });

  if (!mintResponse.ok) {
    return {
      ok: false,
      code: 'mint_failed',
      message: 'Could not mint a realtime session secret.',
      upstream: await readErrorBody(mintResponse),
      upstreamStatus: mintResponse.status,
    };
  }

  const secret = extractClientSecret(await mintResponse.json().catch(() => undefined));
  if (!secret) {
    return {
      ok: false,
      code: 'mint_missing_secret',
      message: 'Realtime mint succeeded but returned no client secret.',
    };
  }

  // The ephemeral secret — not the API key — authenticates the call creation,
  // and this is where a model the account cannot use finally 403s.
  const callResponse = await deps.fetch(REALTIME_CALLS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': SDP_CONTENT_TYPE,
    },
    body: input.offerSdp,
    signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
  });

  if (!callResponse.ok) {
    return {
      ok: false,
      code: 'realtime_call_rejected',
      message: 'OpenAI rejected the realtime call.',
      upstream: await readErrorBody(callResponse),
      upstreamStatus: callResponse.status,
    };
  }

  const location = callResponse.headers.get('Location');
  if (!location) {
    return {
      ok: false,
      code: 'missing_call_location',
      message:
        'OpenAI accepted the call but sent no Location header, so it has no addressable call id.',
    };
  }

  const callId = parseCallId(location);
  if (!callId) {
    return {
      ok: false,
      code: 'malformed_call_location',
      message: `Location header did not carry an ${REALTIME_CALL_ID_PREFIX} call id.`,
    };
  }

  const answerSdp = await callResponse.text();
  if (!answerSdp) {
    return {
      ok: false,
      code: 'missing_answer_sdp',
      message: 'OpenAI accepted the call but returned an empty SDP answer.',
    };
  }

  const outcome = await handOff(deps, input, callId, secret);

  if (outcome.kind === 'refused') {
    // The call exists at OpenAI and the browser is holding an answer for it, so
    // refusing to attach is not enough — it has to be ended.
    await abandonCall(deps, callId, secret);
    return {
      ok: false,
      code: 'admission_refused',
      message: outcome.message,
      upstreamStatus: outcome.status,
    };
  }

  return { ok: true, callId, answerSdp, attached: outcome.kind === 'attached' };
};
