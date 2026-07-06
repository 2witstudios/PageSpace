import { describe, it, expect } from 'vitest';
import { aggregateUsageBreakdown, type UsageLedgerRow } from '../usage-breakdown';

const PERIOD = { periodStart: '2026-06-01T00:00:00.000Z', periodEnd: '2026-07-01T00:00:00.000Z' };

const row = (over: Partial<UsageLedgerRow>): UsageLedgerRow => ({
  source: 'chat',
  model: 'anthropic/claude-opus-4.8',
  provider: 'openrouter',
  chargeMillicents: 25_000, // 25 cents
  totalTokens: 1000,
  pageId: null,
  pageTitle: null,
  durationMs: null,
  ...over,
});

describe('aggregateUsageBreakdown', () => {
  it('returns a zeroed result with empty arrays for no rows', () => {
    const r = aggregateUsageBreakdown([], PERIOD);
    expect(r.totalSpendCents).toBe(0);
    expect(r.byFeature).toEqual([]);
    expect(r.byModel).toEqual([]);
    expect(r.byMachine).toEqual([]);
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

  it('floors a tiny-but-nonzero spend share at 1% (never 0% next to real spend)', () => {
    const rows = [
      row({ source: 'chat', chargeMillicents: 999_000 }), // ~99.9%
      row({ source: 'voice', chargeMillicents: 100 }), // ~0.01% — would round to 0
    ];
    const r = aggregateUsageBreakdown(rows, PERIOD);
    const voice = r.byFeature.find((f) => f.source === 'voice')!;
    expect(voice.spendCents).toBeGreaterThan(0);
    expect(voice.sharePct).toBe(1);
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

  describe('byMachine (Terminal Epic 3 usage surface)', () => {
    const terminalRow = (over: Partial<UsageLedgerRow>): UsageLedgerRow =>
      row({
        source: 'terminal',
        model: 'terminal-machine',
        provider: 'sprites',
        totalTokens: 0,
        ...over,
      });

    it('groups terminal rows by pageId, summing spend and active seconds', () => {
      const r = aggregateUsageBreakdown(
        [
          terminalRow({ pageId: 'page-a', pageTitle: 'My Project', chargeMillicents: 10_000, durationMs: 30_000 }),
          terminalRow({ pageId: 'page-a', pageTitle: 'My Project', chargeMillicents: 5_000, durationMs: 10_000 }),
          terminalRow({ pageId: 'page-b', pageTitle: 'Scratch', chargeMillicents: 20_000, durationMs: 60_000 }),
        ],
        PERIOD,
      );
      expect(r.byMachine).toHaveLength(2);
      const a = r.byMachine.find((m) => m.pageId === 'page-a')!;
      expect(a).toMatchObject({ label: 'My Project', spendCents: 15, calls: 2, activeSeconds: 40 });
      const b = r.byMachine.find((m) => m.pageId === 'page-b')!;
      expect(b).toMatchObject({ label: 'Scratch', spendCents: 20, calls: 1, activeSeconds: 60 });
    });

    it('excludes non-terminal rows entirely, even ones that happen to carry a pageId', () => {
      const r = aggregateUsageBreakdown(
        [row({ source: 'chat', pageId: 'page-a', pageTitle: 'My Project', chargeMillicents: 50_000 })],
        PERIOD,
      );
      expect(r.byMachine).toEqual([]);
    });

    it('collapses rows with no resolvable page into one "Unattributed machine" bucket rather than dropping them', () => {
      const r = aggregateUsageBreakdown(
        [
          terminalRow({ pageId: null, pageTitle: null, chargeMillicents: 5_000, durationMs: 5_000 }),
          terminalRow({ pageId: null, pageTitle: null, chargeMillicents: 5_000, durationMs: 5_000 }),
        ],
        PERIOD,
      );
      expect(r.byMachine).toHaveLength(1);
      expect(r.byMachine[0]).toMatchObject({ pageId: null, label: 'Unattributed machine', calls: 2 });
    });

    it('falls back to "Untitled machine" when the page has no title (deleted/unresolvable page)', () => {
      const r = aggregateUsageBreakdown(
        [terminalRow({ pageId: 'page-c', pageTitle: null, chargeMillicents: 5_000, durationMs: 5_000 })],
        PERIOD,
      );
      expect(r.byMachine[0]).toMatchObject({ pageId: 'page-c', label: 'Untitled machine' });
    });

    it('tolerates a null durationMs (e.g. an idle-storage charge, which has no wall-clock window) as 0 runtime without dropping its cost', () => {
      const r = aggregateUsageBreakdown(
        [terminalRow({ pageId: 'page-d', pageTitle: 'Storage-billed page', chargeMillicents: 5_000, durationMs: null })],
        PERIOD,
      );
      expect(r.byMachine[0]).toMatchObject({ pageId: 'page-d', activeSeconds: 0, spendCents: 5, calls: 1 });
    });

    it('computes sharePct against TOTAL TERMINAL spend, not overall spend across all features', () => {
      const r = aggregateUsageBreakdown(
        [
          row({ source: 'chat', chargeMillicents: 900_000 }), // huge non-terminal spend
          terminalRow({ pageId: 'page-a', pageTitle: 'A', chargeMillicents: 7_500 }),
          terminalRow({ pageId: 'page-b', pageTitle: 'B', chargeMillicents: 2_500 }),
        ],
        PERIOD,
      );
      const a = r.byMachine.find((m) => m.pageId === 'page-a')!;
      const b = r.byMachine.find((m) => m.pageId === 'page-b')!;
      expect(a.sharePct).toBe(75);
      expect(b.sharePct).toBe(25);
    });

    it('sorts byMachine by spend descending', () => {
      const r = aggregateUsageBreakdown(
        [
          terminalRow({ pageId: 'small', pageTitle: 'Small', chargeMillicents: 1_000 }),
          terminalRow({ pageId: 'big', pageTitle: 'Big', chargeMillicents: 50_000 }),
        ],
        PERIOD,
      );
      expect(r.byMachine.map((m) => m.pageId)).toEqual(['big', 'small']);
    });
  });
});
