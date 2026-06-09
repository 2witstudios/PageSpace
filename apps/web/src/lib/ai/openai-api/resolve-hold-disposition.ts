/**
 * Decide what should happen to a chat credit hold when a v1 request leaves the normal
 * "stream finished and settled itself" path. Extracted as a pure function so the
 * OpenAI-compat streaming shell (apps/web/src/app/api/v1/chat/completions/route.ts)
 * stays thin and the hold-disposition decision is unit-testable in isolation.
 *
 * Background: the gate reserves a credit hold + an in-flight slot before any model call.
 * Leaving it un-disposed strands the user's credits and one of MAX_CHAT_INFLIGHT slots
 * until the hold's TTL expires — the leak this function exists to close.
 *
 * Phases:
 *  - 'setup'     — a throw before streamText took over the hold (capabilities /
 *                  convertToModelMessages / persistence). No provider tokens were ever
 *                  billed, so the hold is freed outright.
 *  - 'streaming' — an error or abort surfaced while consuming the model stream. The hold
 *                  is still live and is disposed of based on what actually happened.
 */
export type HoldPhase = 'setup' | 'streaming';

export interface HoldDispositionInput {
  /** Where in the request lifecycle the disposition is being decided. */
  phase: HoldPhase;
  /** Whether the consumer aborted the connection (vs a genuine error). */
  aborted: boolean;
  /**
   * Whether real, billable token usage was captured. This must reflect token counts the
   * failed-run billing path will actually charge (trackUsage only bills an unsuccessful run
   * when totalTokens > 0) — NOT streamed text or provider cost without tokens, which would
   * settle a misleading $0 row. When false, the hold is released directly instead.
   */
  usage: boolean;
}

/**
 *  - 'release'        — free the hold without billing (nothing was spent).
 *  - 'settle-partial' — bill best-effort partial usage (success:false), which also
 *                       consumes the hold; do this before any release so burned tokens
 *                       are recorded instead of silently dropped.
 *  - 'handed-off'     — the normal stream lifecycle owns settlement (abort path); the
 *                       error handler must not touch the hold.
 */
export type HoldDisposition = 'release' | 'settle-partial' | 'handed-off';

export const resolveHoldDisposition = ({
  phase,
  aborted,
  usage,
}: HoldDispositionInput): HoldDisposition => {
  // Pre-stream failure: streamText never ran, so no tokens were billed — just free the hold.
  if (phase === 'setup') return 'release';
  // Consumer abort: the stream lifecycle settles burned tokens itself; don't double-handle.
  if (aborted) return 'handed-off';
  // Mid-stream error with real spend: bill it best-effort before the hold is consumed.
  if (usage) return 'settle-partial';
  // Mid-stream error with nothing burned: no usage to record, just release the hold.
  return 'release';
};
