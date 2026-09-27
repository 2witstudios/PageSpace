import type { UIMessageChunk } from 'ai';
import { loggers } from '@pagespace/lib/logging/logger-config';

/**
 * TIME-TO-FIRST-TOKEN INSTRUMENTATION for one chat turn, shared by both turn strategies.
 *
 * A turn has two very different halves before the user sees anything:
 *
 *   preflight — request received → the first model request leaves this process
 *               (auth, permission checks, credit hold, history load, prompt assembly,
 *               the per-conversation advisory lock). This is OUR latency.
 *   provider  — first model request → the first model-output chunk comes back
 *               (network, provider queueing, prompt prefill, retries). This is THEIRS.
 *
 * `mark()` stamps named phases through preflight so a slow turn names the step it was
 * slow in. The first-token line is logged once per turn, and the summary rides the usage
 * row's metadata so it is queryable after the fact.
 *
 * THE WATCHDOG is the part that matters for a turn that takes minutes: a turn that never
 * reaches its first token never logs a first-token line either, so without it the one
 * turn worth diagnosing is the one that leaves no trace. At each threshold it logs the
 * last phase reached, i.e. where the turn is stuck RIGHT NOW. Timers are unref'd and
 * finite, so a timer that is never ended costs a few log lines, not a leak.
 */

const SLOW_TURN_THRESHOLDS_MS = [10_000, 30_000, 60_000, 120_000, 300_000];

/** A turn slower than this to its first token logs at warn rather than info. */
const SLOW_FIRST_TOKEN_MS = 10_000;

/**
 * Chunks that mean the MODEL has started answering — not our own framing or data parts.
 * `tool-input-available` matters: a provider that sends a tool call whole (no argument
 * streaming) emits only that chunk, and agent turns often open with a tool call.
 */
const MODEL_OUTPUT_CHUNK_TYPES = new Set<string>([
  'text-start',
  'text-delta',
  'reasoning-start',
  'reasoning-delta',
  'tool-input-start',
  'tool-input-delta',
  'tool-input-available',
]);

export interface TurnTimingSummary {
  /** Request received → first model-output chunk. Null when the model never answered. */
  firstTokenMs: number | null;
  /** Request received → first model request. Our own latency. */
  preflightMs: number | null;
  /** First model request → first model-output chunk. The provider's latency. */
  providerMs: number | null;
  /** Model requests made before the first token (>1 means retries ate into TTFT). */
  attemptsBeforeFirstToken: number;
  /** Phase → ms since the request was received (first occurrence of each phase). */
  marks: Record<string, number>;
}

export interface TurnTimer {
  /** Stamp a preflight phase as COMPLETE. */
  mark: (phase: string) => void;
  /** Add fields (ids, model) to every line this timer logs. */
  annotate: (fields: Record<string, unknown>) => void;
  /** A model request is about to be sent. Called once per attempt. */
  modelRequest: () => void;
  /** Feed every frame of the SDK stream; the first model-output frame stops the clock. */
  observeChunk: (chunk: UIMessageChunk) => void;
  /** The stream (and so `end`) now belongs to the pump; see `endUnlessHandedOff`. */
  handOff: () => void;
  /** The turn is over (stream drained, or it never started one). Idempotent. */
  end: (outcome: string) => void;
  /** For the dispatcher's `finally`: end a turn that returned without handing a stream off. */
  endUnlessHandedOff: (outcome: string) => void;
  summary: () => TurnTimingSummary;
}

export const createTurnTimer = ({
  receivedAt,
}: {
  /** When the HTTP request reached the handler, before auth. */
  receivedAt: number;
}): TurnTimer => {
  const marks: Record<string, number> = {};
  const fields: Record<string, unknown> = {};
  let lastPhase = 'received';
  let modelRequestAt: number | null = null;
  let firstTokenAt: number | null = null;
  let attempts = 0;
  let ended = false;
  let handedOff = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;

  const sinceReceived = () => Date.now() - receivedAt;

  const summary = (): TurnTimingSummary => ({
    firstTokenMs: firstTokenAt === null ? null : firstTokenAt - receivedAt,
    preflightMs: modelRequestAt === null ? null : modelRequestAt - receivedAt,
    providerMs:
      firstTokenAt === null || modelRequestAt === null ? null : firstTokenAt - modelRequestAt,
    attemptsBeforeFirstToken: attempts,
    marks: { ...marks },
  });

  const stopWatchdog = () => {
    if (watchdog !== undefined) clearTimeout(watchdog);
    watchdog = undefined;
  };

  const armWatchdog = (index: number) => {
    const threshold = SLOW_TURN_THRESHOLDS_MS[index];
    if (threshold === undefined) return;
    watchdog = setTimeout(() => {
      if (ended || firstTokenAt !== null) return;
      loggers.ai.warn('AI turn slow: no first token yet', {
        ...fields,
        elapsedMs: sinceReceived(),
        // Where it is stuck: the last completed phase, and whether the model was reached.
        lastPhase,
        waitingOn: modelRequestAt === null ? 'preflight' : 'provider',
        ...summary(),
      });
      armWatchdog(index + 1);
    }, Math.max(0, threshold - sinceReceived()));
    watchdog.unref?.();
  };

  const end = (outcome: string) => {
    if (ended) return;
    ended = true;
    stopWatchdog();
    if (firstTokenAt !== null) return;
    // No model output. Fast is ordinary (auth/credit refusal, /help's inline answer); slow
    // or failed is exactly the turn this module exists to explain.
    const elapsedMs = sinceReceived();
    const meta = { ...fields, outcome, elapsedMs, lastPhase, ...summary() };
    if (elapsedMs >= SLOW_FIRST_TOKEN_MS || outcome === 'error') {
      loggers.ai.warn('AI turn ended with no model output', meta);
    } else {
      loggers.ai.debug('AI turn ended with no model output', meta);
    }
  };

  armWatchdog(0);

  return {
    mark: (phase) => {
      if (!(phase in marks)) marks[phase] = sinceReceived();
      lastPhase = phase;
    },
    annotate: (extra) => {
      Object.assign(fields, extra);
    },
    modelRequest: () => {
      attempts += firstTokenAt === null ? 1 : 0;
      if (modelRequestAt === null) modelRequestAt = Date.now();
      lastPhase = attempts > 1 ? `model_request_attempt_${attempts}` : 'model_request';
    },
    observeChunk: (chunk) => {
      if (firstTokenAt !== null || !MODEL_OUTPUT_CHUNK_TYPES.has(chunk.type)) return;
      firstTokenAt = Date.now();
      stopWatchdog();
      const s = summary();
      if ((s.firstTokenMs ?? 0) >= SLOW_FIRST_TOKEN_MS) {
        loggers.ai.warn('AI turn first token', { ...fields, ...s });
      } else {
        loggers.ai.info('AI turn first token', { ...fields, ...s });
      }
    },
    handOff: () => {
      handedOff = true;
      if (!('response_returned' in marks)) marks.response_returned = sinceReceived();
      // The model request can already be in flight by now; don't mask that.
      if (modelRequestAt === null) lastPhase = 'response_returned';
    },
    end,
    endUnlessHandedOff: (outcome) => {
      if (!handedOff) end(outcome);
    },
    summary,
  };
};
