/**
 * Live voice calls, keyed by `rtc_…` call id.
 *
 * The lookup table the rest of the voice plane addresses through: B3 (tool
 * dispatch), B4 (transcript persistence) and D3 (metering) all start from a
 * call id and need the socket that call is on. Keeping that in one place is
 * also what makes teardown checkable — a call that ends and stays in the map is
 * a leak, and a leak here bills.
 *
 * Follows `socket-registry.ts`: a plain class holding Maps, plus a singleton for
 * the service. Not a new registry idiom, and not a module-level Map hiding
 * inside a function — the class is what makes it constructible per-test.
 */

import type { RealtimeCallSession } from './realtime-call-session';

/**
 * Concurrency ceiling. The account's realtime budget is 40,000 tokens/minute
 * and a single spoken exchange spends hundreds, so a handful of simultaneous
 * calls is enough to start throttling everyone at once. Capping admission is
 * the only lever this process has: once a call is attached, its token spend is
 * the model's to decide.
 */
export const DEFAULT_MAX_CONCURRENT_CALLS = 8;

export class RealtimeCallRegistry {
  private readonly calls = new Map<string, RealtimeCallSession>();

  /**
   * Slots claimed by attaches that are in flight but not yet registered.
   *
   * Without this the cap does not actually cap. Attaching is asynchronous, so
   * "check the size, then await, then register" leaves a window in which every
   * concurrent request sees the same pre-attach size and all of them pass —
   * single-threaded JS does not help, because the gap spans an `await`. A slot
   * is therefore claimed SYNCHRONOUSLY, before the first suspension point.
   */
  private pending = 0;

  constructor(private readonly maxConcurrent: number = DEFAULT_MAX_CONCURRENT_CALLS) {}

  /** True when another call would exceed the cap, counting in-flight attaches. */
  atCapacity(): boolean {
    return this.calls.size + this.pending >= this.maxConcurrent;
  }

  /**
   * Claim a slot for an attach that is about to start. Returns false when full.
   * Every successful reserve MUST be matched by exactly one `releaseSlot()`,
   * whether the attach succeeded or failed — `register` deliberately does not
   * release it, so the accounting has one owner instead of two.
   */
  reserveSlot(): boolean {
    if (this.atCapacity()) return false;
    this.pending += 1;
    return true;
  }

  releaseSlot(): void {
    if (this.pending > 0) this.pending -= 1;
  }

  /** In-flight attaches, for tests and diagnostics. */
  get reserved(): number {
    return this.pending;
  }

  register(session: RealtimeCallSession): void {
    // A re-attach for the same call id replaces the old entry and ends it, so
    // two sockets can never be billing for one conversation.
    const existing = this.calls.get(session.callId);
    if (existing && existing !== session) {
      existing.end('replaced by a newer attach for the same call');
    }
    this.calls.set(session.callId, session);
  }

  get(callId: string): RealtimeCallSession | undefined {
    return this.calls.get(callId);
  }

  /**
   * Drop a call by id. Deregistration is deliberately separate from ending the
   * session: the session's own teardown calls this, so ending from here too
   * would recurse.
   */
  unregister(callId: string): void {
    this.calls.delete(callId);
  }

  /** Every live call for one user — how a "hang up" from any surface finds it. */
  getForUser(userId: string): RealtimeCallSession[] {
    return Array.from(this.calls.values()).filter((s) => s.userId === userId);
  }

  callIds(): string[] {
    return Array.from(this.calls.keys());
  }

  get size(): number {
    return this.calls.size;
  }

  /** Ends every live call. For process shutdown, so nothing bills past exit. */
  endAll(reason: string): void {
    for (const session of Array.from(this.calls.values())) {
      session.end(reason);
    }
    this.calls.clear();
  }
}

/** Singleton for the realtime service, matching `socketRegistry`'s shape. */
export const realtimeCallRegistry = new RealtimeCallRegistry();
