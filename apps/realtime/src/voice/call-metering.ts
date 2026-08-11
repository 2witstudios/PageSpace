/**
 * Billing a call that is still happening.
 *
 * Every other AI path in PageSpace holds credits, runs, and settles once. A
 * voice call cannot: it lasts minutes, its cost arrives incrementally as a
 * `usage` object per `response.done`, and a single hold covering the whole
 * thing would be a guess at a conversation that has not happened yet. So this
 * settles CONTINUOUSLY — hold, talk for a window, settle the window exactly,
 * re-hold for the next — which also means a user who runs out of credit
 * mid-sentence is stopped mid-call rather than discovered at hangup.
 *
 * WHY THIS RUNS IN `apps/realtime` AND NOT OVER THE BRIDGE. Its entire
 * dependency set — `canConsumeAI`, `releaseHold`, `AIMonitoring.trackUsage`,
 * `calculateRealtimeCostDollars` — already lives in `@pagespace/lib`, which this
 * app depends on directly. Tools and transcripts cross to `apps/web` because
 * their owners (the tool registry, `messageRepository`) genuinely cannot move;
 * metering has no such constraint, and routing it through an HTTP hop would add
 * a failure mode between the socket that sees the usage and the ledger that
 * records it, for nothing. The rule is the same either way: the work runs where
 * its owner lives.
 *
 * THREE LIMITS, THREE DIFFERENT FAILURES, and they are not interchangeable:
 *   - the IDLE timeout catches the abandoned call — a pinned tab with a hot mic
 *     that bills for room noise, because server VAD fires happily on ambient
 *     sound;
 *   - the DURATION cap catches the call nobody ever hangs up, and is bounded by
 *     `CREDIT_HOLD_TTL_SECONDS`: a session outliving its own reservation's TTL
 *     would have that reservation swept out from under it mid-call;
 *   - the CONCURRENCY caps catch the account-wide constraint — 40,000
 *     tokens/minute shared by every session on our key — which no per-call
 *     limit can see.
 *
 * `apps/realtime`'s own `MAX_CALL_DURATION_MS` (one hour) is NOT a duplicate of
 * the duration cap here. That one is a socket-leak backstop for a call this
 * layer somehow stopped supervising; this one is the product limit, an order of
 * magnitude tighter, and it is the one that normally fires.
 */

import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import { releaseHold } from '@pagespace/lib/billing/credit-consume';
import {
  REALTIME_IDLE_TIMEOUT_SECONDS,
  REALTIME_MAX_SESSION_SECONDS,
  REALTIME_SESSION_HOLD_ESTIMATE_CENTS,
  REALTIME_MAX_INFLIGHT,
} from '@pagespace/lib/billing/credit-pricing';
import { AIMonitoring } from '@pagespace/lib/monitoring/ai-monitoring';
import {
  calculateRealtimeCostDollars,
  type RealtimeUsage,
} from '@pagespace/lib/monitoring/voice-pricing';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { addUsage, hasUnattributedTokens, isUsageEmpty } from './usage-accumulator';

/**
 * How often an in-progress call flushes what it has spent.
 *
 * Chosen against `REALTIME_SESSION_HOLD_ESTIMATE_CENTS` (10¢, roughly 1.5–2
 * minutes of live conversation): the window has to be comfortably shorter than
 * what one hold covers, or the unsettled tail routinely exceeds the
 * reservation and the hold stops bounding anything. A minute leaves ~2x
 * headroom while keeping the settle count for a full-length call in single
 * digits.
 */
export const SETTLE_INTERVAL_MS = 60_000;

export type MeterStopReason =
  | 'call_ended'
  | 'idle_timeout'
  | 'duration_cap'
  | 'credit_exhausted';

export type CallMeter = {
  /** Fold one response's usage into the running total. */
  record(usage: RealtimeUsage | undefined): void;
  /** Note conversational activity, restarting the idle countdown. */
  touch(): void;
  /** Flush and re-hold now. Exposed for the timer and for tests. */
  settle(): Promise<void>;
  /** Final flush + hold release. Idempotent. */
  stop(reason: MeterStopReason): Promise<void>;
  /** Everything billed so far, across every settle. */
  readonly billedDollars: number;
  readonly stopped: boolean;
};

export type CallMeterOptions = {
  readonly callId: string;
  readonly userId: string;
  readonly conversationId?: string;
  readonly tier: SubscriptionTier;
  readonly model: string;
  /** Called when a limit is hit and the call must be torn down. */
  readonly onLimit: (reason: MeterStopReason, message: string) => void;
  readonly idleTimeoutMs?: number;
  readonly maxDurationMs?: number;
  readonly settleIntervalMs?: number;
  /** Injected so tests need neither real timers nor a real ledger. */
  readonly setIntervalFn?: typeof setInterval;
  readonly clearIntervalFn?: typeof clearInterval;
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
  readonly nowFn?: () => number;
  readonly gate?: typeof canConsumeAI;
  readonly release?: typeof releaseHold;
  readonly track?: typeof AIMonitoring.trackUsage;
};

export type CallMeterStart =
  | { readonly ok: true; readonly meter: CallMeter }
  | { readonly ok: false; readonly reason: string };

/**
 * Take the opening hold and start supervising the call.
 *
 * A refusal here means the call must not attach at all — the reservation is the
 * only thing standing between a free-tier account and an unbounded audio bill,
 * and unlike a text turn there is no natural end at which to notice.
 */
export const startCallMeter = async (
  options: CallMeterOptions,
): Promise<CallMeterStart> => {
  const {
    callId,
    userId,
    conversationId,
    tier,
    model,
    onLimit,
    idleTimeoutMs = REALTIME_IDLE_TIMEOUT_SECONDS * 1000,
    maxDurationMs = REALTIME_MAX_SESSION_SECONDS * 1000,
    settleIntervalMs = SETTLE_INTERVAL_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    nowFn = Date.now,
    gate = canConsumeAI,
    release = releaseHold,
    track = AIMonitoring.trackUsage,
  } = options;

  const opening = await gate(userId, tier, {
    estCostCents: REALTIME_SESSION_HOLD_ESTIMATE_CENTS,
    // Per-USER concurrency. The registry's own cap is per-DEPLOYMENT and cannot
    // express this one: two users at the global limit is fine, one user holding
    // eight calls is not.
    maxInFlight: REALTIME_MAX_INFLIGHT,
  });
  if (!opening.allowed) {
    return { ok: false, reason: opening.reason };
  }

  let holdId = opening.holdId;
  let pending: RealtimeUsage | undefined;
  let billedDollars = 0;
  let stopped = false;
  let settling: Promise<void> = Promise.resolve();

  const startedAt = nowFn();
  let lastActivityAt = startedAt;

  /**
   * Flush the pending window.
   *
   * `trackUsage` TAKES OWNERSHIP of the hold — it settles the real cost against
   * it and releases it — so a new hold has to be opened for the next window, and
   * `holdId` is cleared first so no path can hand the same reservation to two
   * settles. A refused re-hold ends the call: the user is out of credit, and
   * the honest response is to stop talking rather than keep spending.
   */
  const flush = async (): Promise<void> => {
    if (stopped && pending === undefined) return;

    const usage = pending;
    pending = undefined;

    if (usage && !isUsageEmpty(usage)) {
      if (hasUnattributedTokens(usage)) {
        // Priced at zero by design (a token with no modality cannot be priced —
        // audio input is 8x text input). Reported because a call that bills
        // nothing is otherwise indistinguishable from a quiet one.
        loggers.realtime.warn(
          'Realtime voice usage reported tokens with no modality attached; that portion bills $0',
          { callId, userId, model },
        );
      }

      const costDollars = calculateRealtimeCostDollars(model, usage);
      billedDollars += costDollars;
      const settledHoldId = holdId;
      holdId = undefined;

      try {
        await track({
          userId,
          provider: 'openai_voice',
          model,
          source: 'voice',
          providerCostDollars: costDollars,
          duration: nowFn() - startedAt,
          success: true,
          ...(settledHoldId === undefined ? {} : { holdId: settledHoldId }),
          ...(conversationId === undefined ? {} : { conversationId }),
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cachedInputTokens: usage.input_token_details?.cached_tokens ?? 0,
          // Deterministic: the exact quantity OpenAI reported, times the
          // published rate. Not a live provider figure and not a token guess.
          costSource: 'list_price',
          metadata: {
            type: 'voice_realtime',
            callId,
            audioInputTokens: usage.input_token_details?.audio_tokens ?? 0,
            audioOutputTokens: usage.output_token_details?.audio_tokens ?? 0,
          },
        });
      } catch (error) {
        // A failed settle must not take the call down — the user is mid-sentence.
        loggers.realtime.error(
          'Realtime voice usage settle failed; this window is unbilled',
          error instanceof Error ? error : new Error(String(error)),
          { callId, userId },
        );
        // Whether `trackUsage` got far enough to consume the reservation is
        // unknowable from here, and the two outcomes want opposite handling.
        // Releasing covers both: a hold it already settled is a row that no
        // longer exists, so the delete is a no-op, and one it never reached is
        // freed instead of sitting against the balance until its TTL. Control
        // then falls through to taking a fresh hold for the next window.
        if (settledHoldId !== undefined) {
          await release(settledHoldId).catch(() => {
            // Nothing further to do: it expires on its TTL.
          });
        }
      }
    }

    if (stopped || holdId !== undefined) return;

    const next = await gate(userId, tier, {
      estCostCents: REALTIME_SESSION_HOLD_ESTIMATE_CENTS,
      maxInFlight: REALTIME_MAX_INFLIGHT,
    });
    if (!next.allowed) {
      loggers.realtime.info('Realtime voice call stopped: no credit for the next window', {
        callId,
        userId,
        reason: next.reason,
      });
      onLimit('credit_exhausted', 'This call ran out of credits.');
      return;
    }
    holdId = next.holdId;
  };

  /** Settles never overlap: each one chains onto the last. */
  const enqueueFlush = (): Promise<void> => {
    settling = settling.then(flush, flush);
    return settling;
  };

  const settleTimer = setIntervalFn(() => {
    void enqueueFlush();
  }, settleIntervalMs);

  const idleTimer = setIntervalFn(() => {
    if (nowFn() - lastActivityAt < idleTimeoutMs) return;
    loggers.realtime.info('Realtime voice call stopped: idle', {
      callId,
      userId,
      idleMs: nowFn() - lastActivityAt,
    });
    onLimit('idle_timeout', 'The call ended after a long silence.');
  }, Math.max(1_000, Math.floor(idleTimeoutMs / 4)));

  const durationTimer = setTimeoutFn(() => {
    loggers.realtime.info('Realtime voice call stopped: duration cap', {
      callId,
      userId,
      maxDurationMs,
    });
    onLimit('duration_cap', 'The call reached its maximum length.');
  }, maxDurationMs);

  const meter: CallMeter = {
    record(usage) {
      if (stopped || usage === undefined) return;
      pending = addUsage(pending, usage);
      lastActivityAt = nowFn();
    },
    touch() {
      lastActivityAt = nowFn();
    },
    settle() {
      return enqueueFlush();
    },
    async stop(reason) {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(settleTimer);
      clearIntervalFn(idleTimer);
      clearTimeoutFn(durationTimer);

      // The final window still has to settle — the last thing said in a call is
      // usually the most expensive part of it.
      await enqueueFlush();

      if (holdId !== undefined) {
        const abandoned = holdId;
        holdId = undefined;
        // Nothing left to bill against it. Released rather than left to its TTL
        // so the user's spendable balance frees immediately.
        await release(abandoned).catch((error: unknown) => {
          loggers.realtime.warn('Realtime voice hold release failed; it will expire on its TTL', {
            callId,
            userId,
            error: error instanceof Error ? error.message : 'unknown',
          });
        });
      }

      loggers.realtime.info('Realtime voice call metered', {
        callId,
        userId,
        reason,
        billedDollars,
        durationMs: nowFn() - startedAt,
      });
    },
    get billedDollars() {
      return billedDollars;
    },
    get stopped() {
      return stopped;
    },
  };

  return { ok: true, meter };
};
