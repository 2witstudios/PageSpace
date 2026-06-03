import { describe, it, expect } from 'vitest';
import { aggregateUsageBreakdown, type UsageLedgerRow } from '../usage-breakdown';

const PERIOD = { periodStart: '2026-06-01T00:00:00.000Z', periodEnd: '2026-07-01T00:00:00.000Z' };

const row = (over: Partial<UsageLedgerRow>): UsageLedgerRow => ({
  source: 'chat',
  model: 'anthropic/claude-opus-4.8',
  provider: 'openrouter',
  chargeMillicents: 25_000, // 25 cents
  totalTokens: 1000,
  ...over,
});

describe('aggregateUsageBreakdown', () => {
  it('returns a zeroed result with empty arrays for no rows', () => {
    const r = aggregateUsageBreakdown([], PERIOD);
    expect(r.totalSpendCents).toBe(0);
    expect(r.byFeature).toEqual([]);
    expect(r.byModel).toEqual([]);
    expect(r.periodStart).toBe(PERIOD.periodStart);
    expect(r.periodEnd).toBe(PERIOD.periodEnd);
  });

  it('collapses rows of the same source and sums spend, tokens, calls', () => {
    const r = aggregateUsageBreakdown(
      [row({ chargeMillicents: 25_000, totalTokens: 1000 }), row({ chargeMillicents: 75_000, totalTokens: 500 })],
      PERIOD,
    );
    expect(r.byFeature).toHaveLength(1);
    expect(r.byFeature[0]).toMatchObject({ source: 'chat', label: 'Chat', spendCents: 100, tokens: 1500, calls: 2, sharePct: 100 });
    expect(r.totalSpendCents).toBe(100);
  });

  it('folds an unknown source into "other"', () => {
    const r = aggregateUsageBreakdown([row({ source: 'mystery' }), row({ source: null })], PERIOD);
    expect(r.byFeature.map((f) => f.source)).toEqual(['other']);
    expect(r.byFeature[0].calls).toBe(2);
  });

  it('groups byModel on model+provider and sorts both lists by spend desc', () => {
    const r = aggregateUsageBreakdown(
      [
        row({ source: 'pulse', model: 'm-small', provider: 'openrouter', chargeMillicents: 10_000 }),
        row({ source: 'chat', model: 'm-big', provider: 'openrouter', chargeMillicents: 90_000 }),
        row({ source: 'chat', model: 'm-big', provider: 'google', chargeMillicents: 5_000 }),
      ],
      PERIOD,
    );
    // byModel: m-big|openrouter (90), m-small|openrouter (10), m-big|google (5)
    expect(r.byModel.map((m) => [m.model, m.provider, m.spendCents])).toEqual([
      ['m-big', 'openrouter', 90],
      ['m-small', 'openrouter', 10],
      ['m-big', 'google', 5],
    ]);
    // byFeature sorted by spend desc: chat (95) before pulse (10)
    expect(r.byFeature.map((f) => f.source)).toEqual(['chat', 'pulse']);
  });

  it('computes integer-ish share percentages that never divide by zero', () => {
    const r = aggregateUsageBreakdown(
      [row({ source: 'chat', chargeMillicents: 30_000 }), row({ source: 'voice', chargeMillicents: 10_000 })],
      PERIOD,
    );
    const chat = r.byFeature.find((f) => f.source === 'chat')!;
    const voice = r.byFeature.find((f) => f.source === 'voice')!;
    expect(chat.sharePct).toBe(75);
    expect(voice.sharePct).toBe(25);
  });

  it('treats a zero-charge period as 0% shares, not NaN', () => {
    const r = aggregateUsageBreakdown([row({ chargeMillicents: 0, totalTokens: 0 })], PERIOD);
    expect(r.totalSpendCents).toBe(0);
    expect(r.byFeature[0].sharePct).toBe(0);
    expect(Number.isNaN(r.byFeature[0].sharePct)).toBe(false);
  });

  it('tolerates null charge/token fields', () => {
    const r = aggregateUsageBreakdown([row({ chargeMillicents: null, totalTokens: null })], PERIOD);
    expect(r.byFeature[0].spendCents).toBe(0);
    expect(r.byFeature[0].tokens).toBe(0);
    expect(r.byFeature[0].calls).toBe(1);
  });
});
