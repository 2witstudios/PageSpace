/**
 * The runtime half of the frozen-legacy guard (epic "Agent-Session Single
 * Source of Truth", Phase 4 PR 14).
 *
 * PR 14 stopped every `chat_messages` write, so the reconciler's question
 * changed shape: it used to ask "do the two legs AGREE?" and must now ask "is
 * the legacy leg still FROZEN?". The difference is not cosmetic — under the
 * old question every healthy conversation diverges the moment a new message is
 * written, which would bury the one signal this cron exists to raise.
 *
 * What is pinned here:
 *   1. `messages` growing past `chat_messages` is SILENT. This is the normal,
 *      permanent post-PR-14 state; an alert here gets the whole job muted.
 *   2. `chat_messages` SHRINKING is silent — retention, GDPR erasure, page
 *      teardown and the 0248 cascade all still delete from it, legitimately.
 *   3. A legacy row with no identical unified twin is an ERROR-level page: it
 *      can only mean a writer PR 14 missed is still live.
 *   4. The SQL still asks the frozen question. A revert to counting equality
 *      would pass tests 1–3 by accident on hand-fed numbers, so the statement
 *      itself is asserted.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { execute, captured, errorLog, infoLog } = vi.hoisted(() => ({
  execute: vi.fn(),
  captured: { sql: '' },
  errorLog: vi.fn(),
  infoLog: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({ db: { execute } }));

vi.mock('@pagespace/db/operators', () => ({
  // Records the statement so the structural assertion can read it back.
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    captured.sql = strings.reduce(
      (acc, part, i) => acc + part + (i < values.length ? String(values[i]) : ''),
      '',
    );
    return captured.sql;
  },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { error: errorLog, info: infoLog, warn: vi.fn(), debug: vi.fn() } },
}));

import { reconcileMessageUnification } from '../message-unification-reconcile';

interface Row {
  conversationId: string;
  legacyCount: string;
  unifiedCount: string;
  unmirroredLegacy: string;
  legacyMaxCreatedAt: string | null;
  unifiedMaxCreatedAt: string | null;
}

const row = (over: Partial<Row> & { conversationId: string }): Row => ({
  legacyCount: '4',
  unifiedCount: '4',
  unmirroredLegacy: '0',
  legacyMaxCreatedAt: '2026-08-01 10:00:00.000000',
  unifiedMaxCreatedAt: '2026-08-01 10:00:00.000000',
  ...over,
});

const resolveWith = (rows: Row[]) => execute.mockResolvedValue({ rows });

describe('reconcileMessageUnification — frozen legacy leg', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.sql = '';
  });

  it('stays silent while the unified table grows past the frozen one', async () => {
    // The steady state after PR 14: new messages land in `messages` only, so
    // the counts diverge further every day and NONE of it is drift.
    resolveWith([
      row({
        conversationId: 'conv-live',
        legacyCount: '4',
        unifiedCount: '40',
        unmirroredLegacy: '0',
        unifiedMaxCreatedAt: '2026-08-06 09:00:00.000000',
      }),
    ]);

    const run = await reconcileMessageUnification();

    expect(run).toMatchObject({ checked: 1, diverged: 0, unmirroredRows: 0 });
    expect(errorLog).not.toHaveBeenCalled();
    expect(infoLog).toHaveBeenCalled();
  });

  it('stays silent while the frozen table shrinks under retention and erasure', async () => {
    resolveWith([
      row({ conversationId: 'conv-purged', legacyCount: '0', unifiedCount: '12', unmirroredLegacy: '0', legacyMaxCreatedAt: null }),
    ]);

    const run = await reconcileMessageUnification();

    expect(run.diverged).toBe(0);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('pages at ERROR level when a legacy row has no unified twin', async () => {
    resolveWith([
      row({ conversationId: 'conv-clean' }),
      row({
        conversationId: 'conv-thawed',
        legacyCount: '9',
        unifiedCount: '7',
        unmirroredLegacy: '2',
        legacyMaxCreatedAt: '2026-08-06 11:00:00.000000',
      }),
    ]);

    const run = await reconcileMessageUnification();

    expect(run).toMatchObject({ checked: 2, diverged: 1, unmirroredRows: 2 });
    expect(run.samples[0]).toMatchObject({ conversationId: 'conv-thawed', unmirroredLegacy: 2 });
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog.mock.calls[0][0]).toMatch(/FROZEN/);
    // The error carries the evidence an operator needs to find the writer:
    // which conversation, and when the unmirrored row was written.
    expect(errorLog.mock.calls[0][2]).toMatchObject({ unmirroredRows: 2 });
    expect((errorLog.mock.calls[0][2] as { samples: Array<{ legacyMaxCreatedAt: string }> }).samples[0].legacyMaxCreatedAt)
      .toBe('2026-08-06 11:00:00.000000');
  });

  it('reports the worst offender first and caps the sample', async () => {
    resolveWith([
      row({ conversationId: 'conv-small', unmirroredLegacy: '1' }),
      row({ conversationId: 'conv-big', unmirroredLegacy: '30' }),
    ]);

    const run = await reconcileMessageUnification();

    expect(run.unmirroredRows).toBe(31);
    expect(run.samples.map((s) => s.conversationId)).toEqual(['conv-big', 'conv-small']);
  });

  it('flags a capped scan, so "0 diverged" is never read as "0 anywhere"', async () => {
    resolveWith(Array.from({ length: 3 }, (_, i) => row({ conversationId: `c${i}` })));

    const run = await reconcileMessageUnification({ maxConversations: 3, windowHours: 6 });

    expect(run).toMatchObject({ capped: true, windowHours: 6 });
    expect(captured.sql).toContain("INTERVAL '1 hour'");
  });

  it('asks the FROZEN question in SQL, not a count-equality one', async () => {
    resolveWith([]);
    await reconcileMessageUnification();

    // Every legacy row must have an identical twin: a NOT EXISTS against
    // `messages` on the primary key plus the content fingerprint. If this
    // assertion is what breaks, the reconciler was reverted to comparing
    // totals — which is guaranteed to fire on healthy data now.
    expect(captured.sql).toMatch(/NOT EXISTS[\s\S]*FROM messages u/);
    expect(captured.sql).toContain('u."id" = l."id"');
    expect(captured.sql).toContain('u."content" = l."content"');
    expect(captured.sql).toContain('u."isActive" = l."isActive"');
    expect(captured.sql).toContain('u."status" = l."status"');
    // Global conversations never had a legacy leg and must stay out of scope.
    expect(captured.sql).toContain(`c."type" = 'page'`);
  });
});
