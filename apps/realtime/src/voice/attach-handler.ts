/**
 * `POST /api/realtime/attach` — the web tier handing us a live call.
 *
 * The body carries a real OpenAI ephemeral credential, so this endpoint is at
 * least as protected as `/api/broadcast`: the caller proves it is the web
 * backend with an HMAC over the raw body, and that check runs in `index.ts`
 * BEFORE this handler ever parses a field. Nothing here re-decides user access
 * — the web tier already gated voice on the user's tier at the one policy site,
 * exactly as the shell bridge does.
 *
 * ADMISSION ORDER IS DELIBERATE, and each step refuses something the next one
 * could not:
 *   1. the DEPLOYMENT concurrency slot, claimed synchronously (the account's
 *      40,000 tokens/minute is shared by every session on our key);
 *   2. the PER-USER call count, which the deployment cap structurally cannot
 *      express — eight calls spread over eight people is fine, eight held by
 *      one person is not;
 *   3. the CREDIT hold, taken before a socket exists, because a voice call has
 *      no natural end at which an unaffordable one would be noticed.
 * Only then is an OpenAI socket opened. Every one of those refusals costs the
 * caller nothing; opening the socket first and refusing afterwards would have
 * already started the meter.
 *
 * The handler itself takes its dependencies as arguments and returns
 * `{ status, body }`, the shape `shell-io.ts` established, so the whole
 * admission path is testable without a socket, a signature, or a server.
 */

import {
  realtimeAttachPayloadSchema,
  type RealtimeAttachResult,
} from '@pagespace/lib/realtime/voice-bridge-contract';
import { REALTIME_MAX_INFLIGHT } from '@pagespace/lib/billing/credit-pricing';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  attachToCall,
  RealtimeAttachError,
  type AttachOptions,
  type RealtimeCallSession,
} from './realtime-call-session';
import { realtimeCallRegistry, type RealtimeCallRegistry } from './realtime-call-registry';
import { createVoiceBridgeClient, type VoiceBridgeClient } from './voice-bridge-client';
import { startCallMeter, type CallMeterOptions, type CallMeterStart } from './call-metering';
import {
  startVoiceCallRuntime,
  type VoiceCallRuntime,
  type VoiceCallRuntimeOptions,
} from './voice-call-runtime';

export type AttachHandlerDeps = {
  readonly registry: RealtimeCallRegistry;
  readonly attach: (options: AttachOptions) => Promise<RealtimeCallSession>;
  readonly startMeter: (options: CallMeterOptions) => Promise<CallMeterStart>;
  readonly startRuntime: (options: VoiceCallRuntimeOptions) => VoiceCallRuntime;
  readonly bridge: VoiceBridgeClient;
  readonly maxCallsPerUser?: number;
};

export const defaultAttachHandlerDeps: AttachHandlerDeps = {
  registry: realtimeCallRegistry,
  attach: attachToCall,
  startMeter: startCallMeter,
  startRuntime: startVoiceCallRuntime,
  // `WEB_APP_URL` is this process's address for the web tier. It was previously
  // only a CORS origin here, because nothing in this app called web; the voice
  // bridge is the first thing that does.
  bridge: createVoiceBridgeClient({ webUrl: process.env.WEB_APP_URL }),
};

export type AttachHandlerResponse = {
  readonly status: number;
  readonly body: RealtimeAttachResult;
};

/**
 * Validate, admit, meter, attach, register, run.
 *
 * The failure statuses are chosen so the web tier can tell apart the things it
 * might do about them: 400 means the payload was wrong (fix the caller), 429
 * means we are full or the user is over their own limit (retry later), 402
 * means they cannot afford the call, 502 means OpenAI would not give us the
 * session (the call is degraded, not the request). All of them still let the
 * browser keep a working audio call — web treats the whole handoff as
 * best-effort — so the distinction exists for operators, not for control flow.
 */
export const handleRealtimeAttachRequest = async (
  deps: AttachHandlerDeps,
  rawBody: string,
): Promise<AttachHandlerResponse> => {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { success: false, error: 'Invalid JSON' } };
  }

  const parsed = realtimeAttachPayloadSchema.safeParse(json);
  if (!parsed.success) {
    // The message is reported but the payload is NOT logged: it held a secret.
    const reason = parsed.error.issues[0]?.message ?? 'Invalid attach payload';
    loggers.realtime.warn('Realtime attach payload rejected', { reason });
    return { status: 400, body: { success: false, error: reason } };
  }

  const {
    callId,
    secret,
    userId,
    conversationId,
    tools,
    model,
    subscriptionTier,
    timezone,
    locationContext,
    seed,
  } = parsed.data;

  // Claimed synchronously, before the first `await`. Checking the live count
  // and attaching afterwards would let every simultaneous request past a cap of
  // one, because they would all observe the same pre-attach size.
  if (!deps.registry.reserveSlot()) {
    loggers.realtime.warn('Realtime attach refused: concurrent call cap reached', {
      callId,
      userId,
      live: deps.registry.size,
    });
    return {
      status: 429,
      body: { success: false, error: 'Too many concurrent voice calls' },
    };
  }

  let meter: CallMeterStart | undefined;

  try {
    const perUserCap = deps.maxCallsPerUser ?? REALTIME_MAX_INFLIGHT;
    const usersCalls = deps.registry.getForUser(userId).length;
    if (usersCalls >= perUserCap) {
      // Enforced here as well as through the credit gate's `maxInFlight`,
      // because that gate is a no-op when billing is disabled — and a
      // tenant/onprem deployment still has one OpenAI key with one rate limit.
      loggers.realtime.warn('Realtime attach refused: user is already on their limit of calls', {
        callId,
        userId,
        usersCalls,
        perUserCap,
      });
      return {
        status: 429,
        body: { success: false, error: 'Too many concurrent voice calls for this user' },
      };
    }

    // The hold comes BEFORE the socket. Voice is the one AI path with no
    // natural end at which an unaffordable call would be noticed.
    let runtime: VoiceCallRuntime | undefined;
    meter = await deps.startMeter({
      callId,
      userId,
      ...(conversationId === undefined ? {} : { conversationId }),
      tier: subscriptionTier as SubscriptionTier,
      model,
      // The meter cannot end a call by itself — it owns the ledger, not the
      // socket — so a limit it hits is reported here and torn down through the
      // runtime, which is the thing that can also hang up the browser.
      onLimit: (reason) => {
        void runtime?.stop(reason);
      },
    });
    if (!meter.ok) {
      loggers.realtime.info('Realtime attach refused: credit gate', {
        callId,
        userId,
        reason: meter.reason,
      });
      return {
        status: 402,
        body: { success: false, error: `Voice call refused: ${meter.reason}` },
      };
    }
    const startedMeter = meter.meter;

    const session = await deps.attach({
      callId,
      secret,
      userId,
      conversationId,
      tools,
      // Deregistration is wired at attach time rather than after the await, so
      // a socket that dies during the handshake cannot leave an entry behind.
      // The runtime teardown rides along: a call that ends for ANY reason —
      // the caller hanging up, a dropped socket, the duration backstop — has to
      // settle its final window and release its hold.
      onClosed: (id) => {
        deps.registry.unregister(id);
        void runtime?.stop('call_ended');
      },
    });
    deps.registry.register(session);

    runtime = deps.startRuntime({
      session,
      bridge: deps.bridge,
      meter: startedMeter,
      secret,
      seed,
      ...(timezone === undefined ? {} : { timezone }),
      ...(locationContext === undefined ? {} : { locationContext }),
    });

    loggers.realtime.info('Realtime voice call attached', {
      callId,
      userId,
      conversationId,
      toolCount: tools.length,
      seedItems: seed.length,
      model,
      live: deps.registry.size,
    });
    return { status: 200, body: { success: true, callId } };
  } catch (error) {
    const code = error instanceof RealtimeAttachError ? error.code : 'attach_failed';
    loggers.realtime.error(
      'Realtime voice attach failed',
      error instanceof Error ? error : new Error(String(error)),
      { callId, userId, code },
    );
    // The hold was taken before the socket and there is now no call to spend
    // it. Left alone it would sit against the user's balance until its TTL.
    if (meter?.ok) await meter.meter.stop('call_ended');
    return {
      status: 502,
      body: {
        success: false,
        error: error instanceof Error ? error.message : 'Attach failed',
      },
    };
  } finally {
    // Released on every path: the slot's job ended the moment the call either
    // entered the registry (where it is now counted) or failed to.
    deps.registry.releaseSlot();
  }
};
