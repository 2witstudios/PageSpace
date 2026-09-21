/**
 * ADR 0005 §2.2 `rebind` (G1c E2) — a consent is consumed single-use through
 * the shared replay store before a rebind is written. Written RED before
 * `decide-consent-consumption.ts` exists.
 */
import { describe, expect, it } from 'vitest';
import { decideConsentConsumption } from '../decide-consent-consumption';

describe('decideConsentConsumption (G1c E2)', () => {
  it('given the ledger consumed the consent for this call, should proceed', () => {
    const actual = decideConsentConsumption({ outcome: 'consumed' });
    expect(actual).toEqual({ ok: true });
  });

  it('given the consent was already consumed (a replay), should refuse consent_invalid', () => {
    const actual = decideConsentConsumption({ outcome: 'replayed' });
    expect(actual).toEqual({ ok: false, reason: 'consent_invalid' });
  });

  it('given the ledger could not answer, should fail closed with store_unavailable — never assume fresh', () => {
    const actual = decideConsentConsumption({ outcome: 'unavailable' });
    expect(actual).toEqual({ ok: false, reason: 'store_unavailable' });
  });
});
