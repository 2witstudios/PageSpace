import { describe, expect, it } from 'vitest';
import { composeLine, rankSignals } from '../composer';
import type { HomeContext, Signal } from '../types';

const NOW = new Date('2026-09-11T15:00:00Z');

function ctx(overrides: Partial<HomeContext> = {}): HomeContext {
  return {
    userId: 'u1',
    displayName: 'Jono',
    timezone: 'UTC',
    driveIds: ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9'],
    drivesInUse: ['d1'],
    lastVisitAt: new Date('2026-09-11T08:00:00Z'),
    pulseEnabled: true,
    ...overrides,
  };
}

function signal(kind: Signal['kind'], overrides: Partial<Signal> = {}): Signal {
  return {
    kind,
    count: 1,
    computedAt: NOW,
    window: { since: NOW, kind: 'today' },
    text: { lead: `${kind} lead`, short: `${kind} short` },
    action: {},
    ...overrides,
  };
}

describe('rankSignals', () => {
  it('drops zero-count signals', () => {
    const signals = [signal('mention', { count: 0 }), signal('overdue_task', { count: 1 })];
    expect(rankSignals(signals, NOW).map((s) => s.kind)).toEqual(['overdue_task']);
  });

  it('drops signals older than their TTL', () => {
    const stale = signal('due_today', { computedAt: new Date('2026-09-09T00:00:00Z') });
    expect(rankSignals([stale], NOW)).toEqual([]);
  });

  it('sorts survivors by the fixed priority order regardless of input order', () => {
    const signals = [signal('due_today'), signal('mention'), signal('overdue_task')];
    expect(rankSignals(signals, NOW).map((s) => s.kind)).toEqual([
      'mention',
      'overdue_task',
      'due_today',
    ]);
  });
});

describe('composeLine — quiet and solo', () => {
  it('returns the quiet state with no icon when nothing survives', () => {
    const result = composeLine([], ctx(), { asOf: NOW });
    expect(result.lead).toBe('All caught up across 9 drives.');
    expect(result.icon).toBeNull();
    expect(result.rest).toEqual([]);
    expect(result.suggestions).toHaveLength(3);
  });

  it('solo fixture (no mention/DM/invite): tasks due + left off, checkbox-adjacent icon', () => {
    const signals = [
      signal('due_today', {
        count: 2,
        text: { lead: '2 tasks due today', short: '2 tasks due today' },
        action: { prompt: 'Plan today' },
      }),
      signal('left_off', {
        count: 1,
        text: { lead: 'you left off in Trip planning', short: 'you left off in Trip planning' },
        action: { prompt: 'Pick up Trip planning' },
      }),
    ];
    const result = composeLine(signals, ctx({ drivesInUse: ['d1'] }), { asOf: NOW });
    expect(result.lead).toBe('2 tasks due today');
    expect(result.rest).toEqual(['you left off in Trip planning']);
    expect(result.icon).toBe('check-square');
    expect(result.suggestions[0]).toBe('Plan today');
  });

  it('a fixture with only a stale pulse_summary falls to the quiet state', () => {
    const stalePulse = signal('pulse_summary', {
      computedAt: new Date('2026-09-11T08:00:00Z'), // > 6h TTL before NOW
    });
    const result = composeLine([stalePulse], ctx(), { asOf: NOW });
    expect(result.lead).toBe('All caught up across 9 drives.');
    expect(result.icon).toBeNull();
  });

  it('a fixture with only a *fresh* pulse_summary also falls to the quiet state (never sole content)', () => {
    const freshPulse = signal('pulse_summary', { computedAt: NOW });
    const result = composeLine([freshPulse], ctx(), { asOf: NOW });
    expect(result.lead).toBe('All caught up across 9 drives.');
  });
});

describe('composeLine — founder', () => {
  it('leads with the single mention including who and where', () => {
    const signals = [
      signal('mention', {
        count: 1,
        text: {
          lead: 'Sarah is waiting on you in #design-review',
          short: 'Sarah in #design-review',
        },
        action: { prompt: 'Reply to Sarah' },
      }),
      signal('pending_invite', {
        count: 45,
        text: { lead: '45 invites need an RSVP', short: '45 invites' },
        action: { prompt: 'Sort the invites' },
      }),
    ];
    const result = composeLine(signals, ctx(), { asOf: NOW });
    expect(result.lead).toBe('Sarah is waiting on you in #design-review');
    expect(result.icon).toBe('at');
    expect(result.rest).toEqual(['45 invites']);
    expect(result.suggestions).toEqual(['Reply to Sarah', 'Sort the invites', 'What changed this week?']);
  });
});

describe('composeLine — team member in a large org', () => {
  it('never surfaces raw channel totals, even when 38 unread channel messages exist', () => {
    // unread_dm models direct messages only; a 38-unread-channels count is
    // deliberately not modelled as a Signal at all, so it can never leak in.
    const signals = [
      signal('mention', {
        count: 2,
        text: { lead: '2 mentions', short: '2 mentions' },
        action: { prompt: 'Catch up on my mentions' },
      }),
      signal('due_today', {
        count: 4,
        window: { since: NOW, kind: 'today' },
        text: { lead: '4 tasks due this week', short: '4 tasks due this week' },
        action: { prompt: 'What is due this week?' },
      }),
    ];
    const result = composeLine(signals, ctx({ displayName: 'Priya' }), { asOf: NOW });
    expect(result.lead).not.toMatch(/channel/i);
    expect(result.rest.join(' ')).not.toMatch(/channel/i);
    expect(result.lead).toBe('2 mentions');
  });
});

describe('composeLine — returning after a week away', () => {
  it('uses the since-last-visit window and "Welcome back" greeting', () => {
    const lastVisit = new Date('2026-09-02T09:00:00Z');
    const signals = [
      signal('due_today', {
        count: 3,
        text: { lead: '3 tasks assigned to you', short: '3 tasks' },
        action: { prompt: 'Catch me up since 2 Sep' },
      }),
    ];
    const result = composeLine(signals, ctx({ lastVisitAt: lastVisit }), { asOf: NOW });
    expect(result.greeting).toBe('Welcome back, Jono.');
    expect(result.lead?.startsWith('Since ')).toBe(true);
    expect(result.lead).toContain('3 tasks assigned to you');
  });

  it('uses the normal greeting and window when the last visit was recent', () => {
    const result = composeLine(
      [signal('due_today', { count: 1, text: { lead: '1 task', short: '1 task' }, action: {} })],
      ctx({ lastVisitAt: new Date('2026-09-11T08:00:00Z') }),
      { asOf: NOW },
    );
    expect(result.greeting).toBe('Good morning, Jono.');
    expect(result.lead?.startsWith('Since ')).toBe(false);
  });
});

describe('composeLine — agent-heavy solo dev', () => {
  it('leads with the finished-sessions fact and the bot icon', () => {
    const signals = [
      signal('agent_finished', {
        count: 2,
        text: {
          lead: '2 agent sessions finished overnight, 1 needs review',
          short: '2 sessions finished',
        },
        action: { prompt: 'Review the finished sessions' },
      }),
      signal('overdue_task', {
        count: 1,
        text: { lead: '1 task overdue', short: '1 task overdue' },
        action: { prompt: 'What is overdue?' },
      }),
    ];
    const result = composeLine(signals, ctx({ drivesInUse: ['d1', 'd2'] }), { asOf: NOW });
    // overdue_task outranks agent_finished per the priority table, so it leads.
    expect(result.lead).toBe('1 task overdue');
    expect(result.icon).toBe('alert-triangle');
    expect(result.rest).toEqual(['2 sessions finished']);
  });
});

describe('composeLine — width fitting', () => {
  it('drops the lowest-priority trailing fact first when the line is too long', () => {
    const signals = [
      signal('mention', { count: 1, text: { lead: 'A'.repeat(40), short: 'B'.repeat(40) }, action: {} }),
      signal('overdue_task', { count: 1, text: { lead: 'x', short: 'C'.repeat(40) }, action: {} }),
      signal('due_today', { count: 1, text: { lead: 'y', short: 'lowest priority, drop me' }, action: {} }),
    ];
    const result = composeLine(signals, ctx(), { asOf: NOW, maxChars: 88 });
    // due_today outranks nothing here and sorts last, so it is dropped first —
    // the higher-priority overdue_task fact is kept.
    expect(result.rest).toContain('C'.repeat(40));
    expect(result.rest).not.toContain('lowest priority, drop me');
    const joined = [result.lead, ...result.rest].join(' · ');
    expect(joined.length).toBeLessThanOrEqual(88);
  });

  it('drops down to nothing when even the highest-priority trailing fact does not fit', () => {
    const signals = [
      signal('mention', { count: 1, text: { lead: 'A'.repeat(70), short: 'irrelevant' }, action: {} }),
      signal('overdue_task', { count: 1, text: { lead: 'x', short: 'C'.repeat(40) }, action: {} }),
    ];
    const result = composeLine(signals, ctx(), { asOf: NOW, maxChars: 88 });
    expect(result.rest).toEqual([]);
  });
});

describe('composeLine — suggestions', () => {
  it('does not duplicate a generic prompt already emitted by a signal', () => {
    const signals = [
      signal('due_today', {
        count: 1,
        text: { lead: 'x', short: 'x' },
        action: { prompt: 'Plan today' },
      }),
    ];
    const result = composeLine(signals, ctx(), { asOf: NOW });
    expect(result.suggestions.filter((s) => s === 'Plan today')).toHaveLength(1);
  });
});
