/**
 * WHAT THE SERVER DOES WHILE IT IS ON THE CALL.
 *
 * C-A got us onto the socket and holds it open. This is everything that
 * happens on it: the session is seeded from the bound conversation, tool calls
 * are dispatched and answered, both sides of the exchange are written into that
 * conversation as ordinary messages, and every response's usage is metered.
 *
 * These are one module rather than four because they are one event loop. They
 * consume the same frames, in the same order, from the same subscription — a
 * `response.done` carries a tool call AND the usage for the turn that produced
 * it, and the same silence that means "no transcript to write" also means "the
 * idle timer should be running". Split apart, each would need its own copy of
 * the frame plumbing and its own theory of when the call ended.
 *
 * The module owns no connection and no registry entry. It takes a
 * `RealtimeCallSession`, subscribes, and sends client events back — the seam
 * `realtime-call-session.ts` documents as belonging to exactly this layer.
 */

import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  buildFunctionOutput,
  extractFunctionCalls,
  extractRateLimits,
  extractTranscript,
  extractUsage,
  RESPONSE_CREATE,
  type FunctionCall,
} from '@pagespace/lib/realtime/voice-events';
import type {
  RealtimeSeedEventWire,
  VoiceAssistant,
  VoiceLocationContext,
} from '@pagespace/lib/realtime/voice-bridge-contract';
import type { RealtimeCallSession } from './realtime-call-session';
import type { VoiceBridgeClient } from './voice-bridge-client';
import type { CallMeter, MeterStopReason } from './call-metering';
import { hangUpCall } from './call-hangup';

/**
 * Events that mean a human is still in the room.
 *
 * NOT "any inbound frame": `rate_limits.updated` and other housekeeping arrive
 * on a call nobody is participating in, and treating them as activity would
 * make the idle reaper permanently unreachable — which is the failure mode it
 * exists to prevent.
 */
const ACTIVITY_EVENTS = new Set([
  'input_audio_buffer.speech_started',
  'input_audio_buffer.committed',
  'conversation.item.input_audio_transcription.completed',
  'response.done',
]);

const eventType = (event: unknown): string | undefined => {
  if (typeof event !== 'object' || event === null) return undefined;
  const type = (event as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
};

export type VoiceCallRuntimeOptions = {
  readonly session: RealtimeCallSession;
  readonly bridge: VoiceBridgeClient;
  readonly meter: CallMeter;
  /** That call's own ephemeral secret — the only credential this process holds. */
  readonly secret: string;
  readonly seed: readonly RealtimeSeedEventWire[];
  readonly timezone?: string;
  readonly locationContext?: VoiceLocationContext;
  /**
   * The page agent this call is bound to. Echoed on every tool dispatch so the
   * web tier authorizes the tool as that agent rather than as the person who
   * started the call, and applies the agent's own tool allowlist.
   */
  readonly assistant?: VoiceAssistant;
  readonly hangUp?: typeof hangUpCall;
};

export type VoiceCallRuntime = {
  /** Tear down: stop listening, settle the meter, end the call. Idempotent. */
  stop(reason: MeterStopReason): Promise<void>;
};

/**
 * Wire the runtime onto a session that has already reached `session.updated`.
 *
 * The seed goes out FIRST and synchronously, before the first frame can be
 * handled: it is the history the model answers against, and an item that lands
 * after the caller has spoken is history the reply has already missed.
 */
export const startVoiceCallRuntime = (
  options: VoiceCallRuntimeOptions,
): VoiceCallRuntime => {
  const { session, bridge, meter, secret, seed, timezone, locationContext, assistant } =
    options;
  const hangUp = options.hangUp ?? hangUpCall;
  const { callId, userId, conversationId } = session;

  let stopping: Promise<void> | undefined;

  for (const item of seed) {
    session.send(item as unknown as Record<string, unknown>);
  }
  if (seed.length > 0) {
    loggers.realtime.debug('Realtime voice session seeded from its conversation', {
      callId,
      conversationId,
      items: seed.length,
    });
  }

  /**
   * Answer one tool call.
   *
   * `function_call_output` MUST carry a string, and a `response.create` MUST
   * follow it or the model sits on the result without speaking. Both hold on
   * every path below, including failure: a bridge that is down produces a
   * sentence about that rather than silence, because the one unrecoverable
   * outcome is a tool call the model never gets an answer to.
   */
  const answerToolCall = async (call: FunctionCall): Promise<void> => {
    const response = await bridge.send({
      kind: 'tool',
      callId,
      userId,
      ...(conversationId === undefined ? {} : { conversationId }),
      name: call.name,
      argumentsJson: call.argumentsJson,
      ...(timezone === undefined ? {} : { timezone }),
      ...(locationContext === undefined ? {} : { locationContext }),
      ...(assistant === undefined ? {} : { assistant }),
    });

    const output =
      response.ok && response.kind === 'tool'
        ? response.output
        : "I couldn't run that just now. Ask me again in a moment.";

    if (!response.ok) {
      loggers.realtime.warn('Realtime voice tool call could not be dispatched', {
        callId,
        userId,
        tool: call.name,
        error: response.error,
      });
    }

    session.send(buildFunctionOutput(call.callId, output));
  };

  const handleToolCalls = async (calls: readonly FunctionCall[]): Promise<void> => {
    // Concurrent, then ONE `response.create`. A response per output would have
    // the model start speaking about the first tool while the second is still
    // running, and interrupt itself when the second landed.
    //
    // `allSettled`, not `all`: `answerToolCall` ends in `session.send`, which
    // throws if the socket rejects the frame, and `all` rejects on the FIRST
    // such throw. That would skip the `response.create` below and leave the
    // model holding a turn it never speaks — the one unrecoverable outcome this
    // file's header names. One failed answer must not silence the others.
    const settled = await Promise.allSettled(calls.map((call) => answerToolCall(call)));
    for (const result of settled) {
      if (result.status === 'rejected') {
        loggers.realtime.error(
          'Realtime voice tool answer threw',
          result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
          { callId, userId },
        );
      }
    }
    if (session.ended) return;
    session.send(RESPONSE_CREATE);
  };

  const persistTranscript = async (role: 'user' | 'assistant', text: string): Promise<void> => {
    if (!conversationId) {
      // An unbound call is a real, supported state — it still runs tools and
      // still meters. There is simply no thread to write into.
      return;
    }
    const response = await bridge.send({
      kind: 'transcript',
      callId,
      userId,
      conversationId,
      role,
      text,
    });
    if (!response.ok) {
      loggers.realtime.warn('Realtime voice transcript was not persisted', {
        callId,
        conversationId,
        role,
        error: response.error,
      });
    }
  };

  const unsubscribe = session.subscribe((event) => {
    const type = eventType(event);

    if (type && ACTIVITY_EVENTS.has(type)) {
      meter.touch();
    }

    // Usage first: a `response.done` that also carries tool calls is still the
    // response whose cost has to be recorded, and dispatch is async.
    const usage = extractUsage(event);
    if (usage) meter.record(usage);

    for (const snapshot of extractRateLimits(event)) {
      // The account ceiling is 40,000 tokens/minute across every session on the
      // key, which is what the deployment-wide concurrency cap is sized
      // against. Logged so that sizing can be checked against reality rather
      // than rediscovered as throttling.
      if (snapshot.remaining <= snapshot.limit * 0.1) {
        loggers.realtime.warn('Realtime account rate limit is nearly exhausted', {
          callId,
          name: snapshot.name,
          limit: snapshot.limit,
          remaining: snapshot.remaining,
        });
      }
    }

    const calls = extractFunctionCalls(event);
    if (calls.length > 0) {
      void handleToolCalls(calls).catch((error: unknown) => {
        loggers.realtime.error(
          'Realtime voice tool dispatch failed',
          error instanceof Error ? error : new Error(String(error)),
          { callId, userId },
        );
      });
    }

    const transcript = extractTranscript(event);
    if (transcript) {
      // Not awaited: the transcript is the durable record, not part of the live
      // turn, and blocking the event loop on a database write would put a chat
      // persistence latency inside a spoken conversation.
      //
      // Caught for the same reason the tool dispatch above is. `bridge` is an
      // interface, and nothing in its type stops an implementation from
      // rejecting; an unhandled rejection raised inside a socket event handler
      // takes the process down by default, which would drop every OTHER live
      // call in it over one dropped transcript row.
      void persistTranscript(transcript.role, transcript.text).catch((error: unknown) => {
        loggers.realtime.error(
          'Realtime voice transcript persistence threw',
          error instanceof Error ? error : new Error(String(error)),
          { callId, conversationId, role: transcript.role },
        );
      });
    }
  });

  const stop = (reason: MeterStopReason): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      unsubscribe();
      // Metering settles BEFORE the call is torn down: the final window is
      // usually the most expensive part of the call, and a teardown that raced
      // it would drop it.
      //
      // But it must not BLOCK the teardown. A rejecting settle used to skip
      // both the hangup and `session.end` below, leaving exactly the state this
      // whole path exists to prevent — a live browser call with nobody metering
      // it — and the rejection then escaped into the `void runtime?.stop(…)`
      // calls in `attach-handler.ts`, where an unhandled rejection takes the
      // process down and every other live call with it. An unbilled final
      // window is a bad outcome; an unbilled ONGOING call is a worse one.
      try {
        await meter.stop(reason);
      } catch (error) {
        loggers.realtime.error(
          'Realtime voice meter settle threw during teardown; tearing the call down anyway',
          error instanceof Error ? error : new Error(String(error)),
          { callId, userId, reason },
        );
      }
      // Ends the BROWSER's call, not just our view of it — on EVERY reason,
      // including 'call_ended'.
      //
      // 'call_ended' means our attached socket closed, and that is not proof
      // the call did. The same reason covers a network drop, a process
      // shutdown and the one-hour socket backstop, none of which touch the
      // browser's independent WebRTC session: skipping the hangup for those
      // left the user talking to a model whose metering and transcript
      // supervision had already stopped. Asking twice is free — a call that
      // really did end answers 404, which `hangUpCall` reads as "already
      // ended" — while asking zero times bills nobody for a live call.
      await hangUp(callId, secret);
      session.end(reason);
    })();
    return stopping;
  };

  return { stop };
};
