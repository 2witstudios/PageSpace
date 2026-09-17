/**
 * The single-use ledger for `OwnerConsent.consentId` (ADR 0005 §2.2 `rebind`,
 * §2.5; G1c E2) — I/O only. Consents are consumed through the SHARED replay
 * store (`agent_account_grant_nonces`), so a consent applies at most once
 * across every plane replica and restart, exactly as a grant nonce does. A
 * consent id is recorded under its own `consent:` namespace so it can never
 * collide with a grant nonce the authority minted. What an outcome MEANS for a
 * rebind is `decideConsentConsumption`'s, not this file's.
 */
import type { ConsentId, GrantId, Nonce } from '../grant';
import type { ConsumeOutcome, ReplayStoreRepository } from '../replay-store-repository';

export type ConsentLedger = {
  /** Exactly one caller across all replicas ever gets `consumed` for a consent id. */
  readonly consume: (input: { readonly consentId: ConsentId; readonly expiresAt: number; readonly now: number }) => Promise<ConsumeOutcome>;
};

export function createConsentLedgerRepository({ replayStore }: { readonly replayStore: Pick<ReplayStoreRepository, 'consume'> }): ConsentLedger {
  return {
    consume: ({ consentId, expiresAt, now }) => {
      const recorded = `consent:${consentId}`;
      return replayStore.consume({ nonce: recorded as Nonce, grantId: recorded as GrantId, expiresAt, now });
    },
  };
}
