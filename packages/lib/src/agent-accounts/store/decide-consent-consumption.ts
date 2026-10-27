/**
 * `decideConsentConsumption` — what the single-use consumption of an
 * `OwnerConsent` means for a rebind (ADR 0005 §2.2; G1c E2). The adapter
 * consumes `consentId` through the shared replay store BEFORE it writes, so a
 * consent applies at most once across every replica and restart: a replay is
 * `consent_invalid`, and a ledger that cannot answer is `store_unavailable` —
 * never "assume fresh". Pure.
 */
import type { ConsumeOutcome } from '../replay-store-repository';

export function decideConsentConsumption({
  outcome,
}: {
  readonly outcome: ConsumeOutcome;
}): { readonly ok: true } | { readonly ok: false; readonly reason: 'consent_invalid' | 'store_unavailable' } {
  if (outcome === 'consumed') return { ok: true };
  if (outcome === 'replayed') return { ok: false, reason: 'consent_invalid' };
  return { ok: false, reason: 'store_unavailable' };
}
