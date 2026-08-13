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

import { REALTIME_MAX_GLOBAL_SESSIONS } from '@pagespace/lib/billing/credit-pricing';
import type { RealtimeCallSession } from './realtime-call-session';

/**
 * Concurrency ceiling. The account's realtime budget is 40,000 tokens/minute
 * and a single spoken exchange spends hundreds, so a handful of simultaneous
 * calls is enough to start throttling everyone at once. Capping admission is
 * the only lever this process has: once a call is attached, its token spend is
 * the model's to decide.
 *
 * The number itself is `REALTIME_MAX_GLOBAL_SESSIONS`, which is where every
 * other realtime budget knob lives and is what an operator actually tunes. A
 * literal here would have been a second default that silently outranked the
 * documented one.
 */
export const DEFAULT_MAX_CONCURRENT_CALLS = REALTIME_MAX_GLOBAL_SESSIONS;

/**
 * Why an attach was turned away. Named rather than boolean because the two caps
 * mean different things to an operator: `deployment` says the whole process is
 * full and every user is affected, `user` says one person is holding their own
 * limit and nobody else is.
 */
export type SlotRefusal = 'deployment' | 'user';

export type SlotReservation =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusedBy: SlotRefusal };

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

  /**
   * The same claim, per user. `getForUser` counts only REGISTERED calls, and a
   * call is registered two awaits after admission — so a per-user check made
   * from the registered count alone is exactly the race the deployment slot
   * exists to prevent, one scope down: two simultaneous attaches from one
   * person both see zero and both pass a cap of one.
   */
  private readonly pendingByUser = new Map<string, number>();

  constructor(private readonly maxConcurrent: number = DEFAULT_MAX_CONCURRENT_CALLS) {}

  /** True when another call would exceed the cap, counting in-flight attaches. */
  atCapacity(): boolean {
    return this.calls.size + this.pending >= this.maxConcurrent;
  }

  /** A user's calls, live and in-flight — what the per-user cap is measured against. */
  heldByUser(userId: string): number {
    return this.getForUser(userId).length + (this.pendingByUser.get(userId) ?? 0);
  }

  /**
   * Claim a slot for an attach that is about to start, against BOTH caps, in
   * one synchronous step. Every successful reserve MUST be matched by exactly
   * one `releaseSlot(userId)`, whether the attach succeeded or failed —
   * `register` deliberately does not release it, so the accounting has one
   * owner instead of two. A refusal claims nothing and must not be released.
   */
  reserveSlot(userId: string, maxPerUser: number): SlotReservation {
    if (this.atCapacity()) return { ok: false, refusedBy: 'deployment' };
    if (this.heldByUser(userId) >= maxPerUser) return { ok: false, refusedBy: 'user' };
    this.pending += 1;
    this.pendingByUser.set(userId, (this.pendingByUser.get(userId) ?? 0) + 1);
    return { ok: true };
  }

  releaseSlot(userId: string): void {
    if (this.pending > 0) this.pending -= 1;
    const held = this.pendingByUser.get(userId) ?? 0;
    // Deleted rather than left at zero: the map is keyed by every user who has
    // ever attached, and a process that keeps one entry per user forever is a
    // slow leak in the thing whose job is to notice leaks.
    if (held <= 1) this.pendingByUser.delete(userId);
    else this.pendingByUser.set(userId, held - 1);
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
