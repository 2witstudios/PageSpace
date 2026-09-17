/**
 * The grant gate — the ONE I/O shell around the pure verifier (ADR 0004
 * §2.4, §8.11). No decision logic lives here: it looks the nonce up, hands
 * the ledger's facts to `decideReplay`, calls `verifyGrant`, and records the
 * nonce ONLY when the whole verdict is `ok`. A grant that failed any check
 * leaves the ledger untouched; a malformed one is refused before the ledger
 * is even consulted.
 *
 * Consumption is the ledger's atomic insert, so two replicas presenting the
 * same grant both verify `ok` on their own pure pass and exactly one of them
 * gets `consumed` — the other is `replayed`. A ledger that cannot be reached
 * is `replay_store_unavailable`, never "assume fresh".
 *
 * Integration-tested against the real `:5433` Postgres
 * (`__tests__/grant-gate-executor.integration.test.ts`).
 */
import type { GrantVerdict, VerifyGrantInput } from './grant';
import { parseGrant } from './parse-grant';
import { verifyGrant } from './verify-grant';
import { decideReplay } from './decide-replay';
import type { ReplayStoreRepository } from './replay-store-repository';

/** Everything the verifier needs except the nonce state, which the gate fetches. */
export type GrantPresentation = Omit<VerifyGrantInput, 'nonceState'>;

export type GrantGate = {
  readonly present: (input: GrantPresentation) => Promise<GrantVerdict>;
};

export function createGrantGate({ replayStore }: { readonly replayStore: ReplayStoreRepository }): GrantGate {
  return {
    async present(input) {
      const parsed = parseGrant({ grant: input.grant });
      if (!parsed.ok) return { ok: false, reason: 'malformed' };

      const lookup = await replayStore.lookup({ nonce: parsed.grant.nonce });
      const nonceState = decideReplay({ lookup, now: input.now });
      const verdict = verifyGrant({ ...input, nonceState });
      if (!verdict.ok) return verdict;

      // Only now — the whole verdict is ok — does the nonce burn.
      const consumed = await replayStore.consume({ nonce: verdict.grant.nonce, grantId: verdict.grant.grantId, expiresAt: verdict.grant.exp, now: input.now });
      if (consumed === 'consumed') return verdict;
      return { ok: false, reason: consumed === 'replayed' ? 'replayed' : 'replay_store_unavailable' };
    },
  };
}
