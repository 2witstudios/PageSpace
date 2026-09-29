import { describe, it, expect } from 'vitest';
import type { CreditGateResult } from '@pagespace/lib/billing/credit-gate';
import { driveSpend } from '@pagespace/lib/billing/spend-target';
import { SPEND_FALLBACK_PART_TYPE, spendFallbackPart, turnCreditAfterGate } from '../turn-credit';

const allowed = (over: Partial<CreditGateResult> = {}): CreditGateResult => ({
  allowed: true,
  reason: 'ok',
  holdId: 'h1',
  walletId: 'w-marcus',
  spendSource: 'own_credits',
  entitlementTier: 'free',
  ...over,
});

describe('turn credit: a drive-rule fallback reaches the turn and the stream', () => {
  it('SPEND-4 (partial) the turn keeps the fallback the gate reported, from and to', () => {
    const credit = turnCreditAfterGate(driveSpend('d-side', 'drive_wallet'), allowed({ fallback: { from: 'drive_wallet', to: 'own_credits' } }));

    expect(credit.fallback).toEqual({ from: 'drive_wallet', to: 'own_credits' });
    // Follow-on calls in the turn name the source actually held, never the one fallen back from.
    expect(credit.spend).toEqual({ kind: 'drive', driveId: 'd-side', chosen: 'own_credits' });
  });

  it('SPEND-4 (partial) a fallback becomes a data part the client receives, naming both sources', () => {
    const credit = turnCreditAfterGate(driveSpend('d-side', 'drive_wallet'), allowed({ fallback: { from: 'drive_wallet', to: 'own_credits' } }));

    expect(spendFallbackPart(credit, 'msg-1')).toEqual({
      type: SPEND_FALLBACK_PART_TYPE,
      id: 'msg-1-spend-fallback',
      data: { from: 'drive_wallet', to: 'own_credits', walletId: 'w-marcus' },
    });
    expect(SPEND_FALLBACK_PART_TYPE).toBe('data-spend-fallback');
  });

  it('SPEND-4 (partial) a turn that spent its chosen source writes no fallback part', () => {
    const credit = turnCreditAfterGate(driveSpend('d-side', 'drive_wallet'), allowed({ walletId: 'w-side', spendSource: 'drive_wallet' }));

    expect(credit.fallback).toBeUndefined();
    expect(spendFallbackPart(credit, 'msg-1')).toBeNull();
  });
});
