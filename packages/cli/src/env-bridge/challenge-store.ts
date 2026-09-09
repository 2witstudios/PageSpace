/**
 * Pending chat approvals on the daemon — the challenge store (GA wave 2,
 * leaf 4; Tier B).
 *
 * When a request reaches the `ask` verdict and there is no terminal to ask on
 * (or the owner prefers the chat), the daemon does not deny and forget: it
 * FREEZES the exact normalised request under a challenge id, answers
 * `grant_denied ask_pending:<id>` carrying that frozen request (signed, so the
 * card in the chat shows what the machine will run and nothing else), and
 * waits. The owner's click comes back as a fresh grant carrying a
 * server-signed `approvalIntent { challengeId }`; the dispatcher looks the
 * frozen request up HERE and byte-compares the new request against it before
 * anything runs (leaf 7). A click can only ever unblock a request this store
 * is still holding.
 *
 * Bounded and evicted synchronously exactly like `nonce-store.ts`: the TTL of
 * a challenge is the grant's own `exp` (the whole authorization, prompt
 * included, is bounded by the grant — `decide-execution.ts`), `evictExpired`
 * runs before every use with no `await` between it and the lookup, and the
 * map never holds more than MAX_PENDING_CHALLENGES live entries. A second ask
 * for the same subject while one is pending REUSES the id (and the first
 * frozen request) rather than growing the map: the agent retrying is not a
 * new question.
 */
import type { Grant, NormalizedRequest } from './lib-core.js';

/** Live entries at most; a further ask while this many are pending is refused (`ask_unavailable`), never evicted early. */
export const MAX_PENDING_CHALLENGES = 64;

export interface PendingChallenge {
  readonly id: string;
  /** The VERIFIED grant of the request that was frozen (its principal and op are what a click must match). */
  readonly grant: Grant;
  /** The frozen `NormalizedRequest` the owner is shown and the click is compared against. */
  readonly request: NormalizedRequest;
  /** What a durable approval of it would be keyed on; `null` = nothing durable can be written. */
  readonly subjects: readonly string[] | null;
  /** ms since epoch — the grant's `exp`. */
  readonly exp: number;
  readonly issuedAt: number;
}

export interface IssueChallengeInput {
  readonly grant: Grant;
  readonly request: NormalizedRequest;
  readonly subjects: readonly string[] | null;
}

export interface ChallengeStore {
  /** Freeze a request; reuse the pending id for the same (user, op, subject). `null` when the store is full. */
  issue(input: IssueChallengeInput, now: number): PendingChallenge | null;
  /** Read a live challenge without consuming it; `undefined` when unknown or expired. */
  peek(id: string, now: number): PendingChallenge | undefined;
  /** Consume a live challenge; `undefined` when unknown or expired (an expired one is dropped). */
  take(id: string, now: number): PendingChallenge | undefined;
  /** Forget challenges whose grants have expired. Called before every use. */
  evictExpired(now: number): void;
  /** Live entries — for tests and a status line, never for a decision. */
  size(): number;
}

export interface ChallengeStoreDeps {
  readonly newId: () => string;
  readonly max?: number;
}

/** The reuse key: one pending question per (user, op, subject set); an unresolvable request keys on its exact args. */
function reuseKey(input: IssueChallengeInput): string {
  const subject = input.subjects === null ? `args:${input.grant.argsHash}` : input.subjects.join(' ');
  return `${input.grant.principal.userId} ${input.grant.op} ${subject}`;
}

export function createChallengeStore(deps: ChallengeStoreDeps): ChallengeStore {
  const max = deps.max ?? MAX_PENDING_CHALLENGES;
  const byId = new Map<string, PendingChallenge>();
  const byKey = new Map<string, string>();

  const drop = (id: string) => {
    const entry = byId.get(id);
    if (entry === undefined) return;
    byId.delete(id);
    for (const [key, pendingId] of byKey) if (pendingId === id) byKey.delete(key);
  };

  const evictExpired = (now: number) => {
    for (const [id, entry] of byId) if (entry.exp < now) drop(id);
  };

  return {
    issue(input, now) {
      evictExpired(now);
      const key = reuseKey(input);
      const existingId = byKey.get(key);
      if (existingId !== undefined) {
        const existing = byId.get(existingId);
        if (existing !== undefined) return existing;
      }
      if (byId.size >= max) return null;
      const entry: PendingChallenge = { id: deps.newId(), grant: input.grant, request: input.request, subjects: input.subjects, exp: input.grant.exp, issuedAt: now };
      byId.set(entry.id, entry);
      byKey.set(key, entry.id);
      return entry;
    },
    peek(id, now) {
      evictExpired(now);
      return byId.get(id);
    },
    take(id, now) {
      evictExpired(now);
      const entry = byId.get(id);
      if (entry !== undefined) drop(id);
      return entry;
    },
    evictExpired,
    size: () => byId.size,
  };
}
