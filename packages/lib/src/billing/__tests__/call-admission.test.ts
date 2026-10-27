import { describe, it, expect } from 'vitest';
import { callAdmission } from '../call-admission';
import { PERSONAL_SPEND, automationSpend, conversationSpend, driveSpend } from '../spend-target';

describe('callAdmission — what a call outside a request turn reserves (compaction, memory cron)', () => {
  it('SPEND-1 (partial) a metered follow-on call is gated on the exact target its turn spent', () => {
    const spend = { ...conversationSpend('drive-product', 'conv-1'), chosen: 'drive_wallet' as const };
    expect(callAdmission({ meteringExempt: false, spend, estCostCents: 7 })).toEqual({
      gate: true,
      spend: spend,
      estCostCents: 7,
    });
  });

  it('SPEND-6 (partial) an automation turn\'s follow-on call is gated on the drive, never on a person', () => {
    const admission = callAdmission({ meteringExempt: false, spend: automationSpend('drive-product'), estCostCents: 3 });
    expect(admission).toEqual({ gate: true, spend: automationSpend('drive-product'), estCostCents: 3 });
  });

  it('SPEND-8 (partial) a call with no drive (a turn outside any drive, the memory cron) is gated on personal credits', () => {
    expect(callAdmission({ meteringExempt: false, spend: PERSONAL_SPEND, estCostCents: 5 })).toEqual({
      gate: true,
      spend: PERSONAL_SPEND,
      estCostCents: 5,
    });
  });

  it('a flat-rate (metering-exempt) provider reserves nothing, as its turn did not', () => {
    expect(callAdmission({ meteringExempt: true, spend: driveSpend('drive-product'), estCostCents: 5 })).toEqual({ gate: false });
  });

  it('never reserves less than one cent: a metered call always holds something before it runs', () => {
    expect(callAdmission({ meteringExempt: false, spend: PERSONAL_SPEND, estCostCents: 0 })).toMatchObject({ gate: true, estCostCents: 1 });
    expect(callAdmission({ meteringExempt: false, spend: PERSONAL_SPEND, estCostCents: Number.NaN })).toMatchObject({ gate: true, estCostCents: 1 });
    expect(callAdmission({ meteringExempt: false, spend: PERSONAL_SPEND, estCostCents: 4.2 })).toMatchObject({ gate: true, estCostCents: 5 });
  });
});
