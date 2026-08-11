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
  const { session, bridge, meter, secret, seed, timezone, locationContext } = options;
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
    await Promise.all(calls.map((call) => answerToolCall(call)));
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
      void persistTranscript(transcript.role, transcript.text);
    }
  });

  const stop = (reason: MeterStopReason): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      unsubscribe();
      // Metering settles BEFORE the call is torn down: the final window is
      // usually the most expensive part of the call, and a teardown that raced
      // it would drop it.
      await meter.stop(reason);
      // Ends the BROWSER's call, not just our view of it. Skipped for
      // 'call_ended', where the socket closing is what told us in the first
      // place and OpenAI has already torn the call down.
      if (reason !== 'call_ended') {
        await hangUp(callId, secret);
      }
      session.end(reason);
    })();
    return stopping;
  };

  return { stop };
};
