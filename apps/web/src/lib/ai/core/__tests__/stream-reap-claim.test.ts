import { describe, it, beforeEach, vi } from 'vitest';
import { assert } from './riteway';

const {
  mockUpdateSet,
  mockUpdateWhere,
  mockReturning,
  mockSelectLimit,
  mockLoggerWarn,
} = vi.hoisted(() => ({
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockReturning: vi.fn(),
  mockSelectLimit: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    update: vi.fn(() => ({ set: mockUpdateSet })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((cond: unknown) => {
          mockSelectWhereArg(cond);
          return { limit: mockSelectLimit };
        }),
      })),
    })),
  },
}));

const mockSelectWhereArg = vi.fn();

// Identity-shaped operators (the house pattern) so a case can assert on the PREDICATE itself
// rather than trusting drizzle to have built it correctly. `sql` returns a marker carrying the
// interpolated values, which is how the staleness/TTL comparisons below are inspected.
vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn((...args: unknown[]) => ({ conds: args })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
  lte: vi.fn((field: unknown, value: unknown) => ({ field, lteValue: value })),
  isNull: vi.fn((field: unknown) => ({ isNull: field })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ sqlText: strings.join('?'), values }),
    {},
  ),
}));

vi.mock('@pagespace/db/schema/ai-streams', () => ({
  aiStreamSessions: {
    messageId: 'ai_stream_sessions.message_id',
    status: 'ai_stream_sessions.status',
    channelId: 'ai_stream_sessions.channel_id',
    conversationId: 'ai_stream_sessions.conversation_id',
    userId: 'ai_stream_sessions.user_id',
    parts: 'ai_stream_sessions.parts',
    rawPartsCount: 'ai_stream_sessions.raw_parts_count',
    startedAt: 'ai_stream_sessions.started_at',
    lastHeartbeatAt: 'ai_stream_sessions.last_heartbeat_at',
    reapClaimedAt: 'ai_stream_sessions.reap_claimed_at',
  },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { info: vi.fn(), warn: mockLoggerWarn, error: vi.fn(), debug: vi.fn() } },
}));

import {
  claimDeadStream,
  isReapClaimStillHeld,
  reapClaimFence,
  REAP_CLAIM_TTL_MS,
  type ReapClaim,
} from '../stream-reap-claim';
import { STREAM_HEARTBEAT_STALE_MS } from '../stream-liveness';

const CLAIMED_AT = new Date('2026-08-15T00:05:00.000Z');
const HEARTBEAT_AT = new Date('2026-08-15T00:00:00.000Z');

const dbRow = (over: Record<string, unknown> = {}) => ({
  messageId: 'msg-1',
  claimedAt: CLAIMED_AT,
  heartbeatAtClaim: HEARTBEAT_AT,
  channelId: 'page-abc',
  conversationId: 'conv-1',
  userId: 'user-a',
  parts: [{ type: 'text', text: 'partial' }],
  rawPartsCount: 7,
  startedAt: new Date('2026-08-15T00:00:00.000Z'),
  ...over,
});

const claim = (over: Partial<ReapClaim> = {}): ReapClaim => ({ ...dbRow(), ...over } as ReapClaim);

type Cond = { field?: string; value?: unknown; lteValue?: unknown; sqlText?: string; values?: unknown[]; or?: unknown[]; isNull?: unknown };

const conds = (arg: unknown): Cond[] => (arg as { conds: Cond[] }).conds;

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
  mockUpdateWhere.mockReturnValue({ returning: mockReturning });
  mockReturning.mockResolvedValue([dbRow()]);
  mockSelectLimit.mockResolvedValue([{ messageId: 'msg-1' }]);
});

describe('claimDeadStream — the predicate', () => {
  it('sets the claim token from the database clock, truncated to milliseconds', async () => {
    await claimDeadStream({ messageId: 'msg-1' });

    // TWO SEPARATE REQUIREMENTS, both in one expression, so neither can be dropped silently.
    //
    // `now()` — CLOCK SKEW IS THE POINT. `isProvablyDead(row, Date.now())` compares a Postgres
    // timestamp against the READING instance's clock, and at N>1 two machines drift. A token
    // minted from `new Date()` would be compared against `now()` by its own TTL check, so a
    // skewed reaper could mint a claim its own expiry test then misreads.
    //
    // `date_trunc('milliseconds', …)` — PRECISION. `timestamp` keeps microseconds; a JS `Date`
    // holds only milliseconds, so an untruncated token comes back through the driver shortened
    // and the fence's equality then matches ZERO rows — every settle and every frame release
    // rejected, forever. This assertion is the cheap guard; the real one is
    // `stream-reap-claim.integration.test.ts`, which runs the round trip against a real
    // database (review finding — chatgpt-codex-connector, PR #2419).
    assert({
      given: 'a claim attempt',
      should: 'write reap_claimed_at from now(), truncated to a precision the driver can carry',
      actual: (mockUpdateSet.mock.calls[0][0] as { reapClaimedAt: { sqlText?: string } }).reapClaimedAt.sqlText,
      expected: "date_trunc('milliseconds', now())",
    });
  });

  it('claims only a row that is STILL streaming', async () => {
    await claimDeadStream({ messageId: 'msg-1' });

    assert({
      given: 'the claiming UPDATE',
      should: 'require status = streaming — a row that left it was already settled',
      actual: conds(mockUpdateWhere.mock.calls[0][0]).find((c) => c.field === 'ai_stream_sessions.status')?.value,
      expected: 'streaming',
    });
  });

  it('re-evaluates STALENESS in the statement, against the database clock', async () => {
    await claimDeadStream({ messageId: 'msg-1' });

    // The TOCTOU close. The caller's `isProvablyDead` ran against a row read seconds ago; a
    // heartbeat landing in between makes this clause false and the claim is refused.
    const stale = conds(mockUpdateWhere.mock.calls[0][0]).find((c) => c.values?.[0] === 'ai_stream_sessions.last_heartbeat_at');
    assert({
      given: 'the claiming UPDATE',
      should: 'compare last_heartbeat_at against now() minus the stale window, in SQL',
      actual: {
        comparesToNow: stale?.sqlText?.includes('now()') ?? false,
        seconds: (stale?.values?.[1] as { values?: unknown[] } | undefined)?.values?.[0],
      },
      expected: { comparesToNow: true, seconds: STREAM_HEARTBEAT_STALE_MS / 1000 },
    });
  });

  it('honours an explicit staleAfterMs rather than always using the default horizon', async () => {
    await claimDeadStream({ messageId: 'msg-1', staleAfterMs: 30_000 });

    const stale = conds(mockUpdateWhere.mock.calls[0][0]).find((c) => c.values?.[0] === 'ai_stream_sessions.last_heartbeat_at');
    assert({
      given: 'a caller-supplied staleness horizon',
      should: 'build the interval from it',
      actual: (stale?.values?.[1] as { values?: unknown[] } | undefined)?.values?.[0],
      expected: 30,
    });
  });

  it('takes the claim only when nobody holds it, or the holder has gone quiet', async () => {
    await claimDeadStream({ messageId: 'msg-1' });

    // MUTUAL EXCLUSION at N>1: exactly one instance's UPDATE can set the column. And a
    // SELF-EXPIRY, so a reaper that dies mid-reap does not wedge the row forever — the row
    // deliberately stays 'streaming' throughout, which is what makes the retry possible.
    const alternatives = conds(mockUpdateWhere.mock.calls[0][0]).find((c) => c.or !== undefined)?.or as Cond[];
    assert({
      given: 'the claiming UPDATE',
      should: 'accept an unclaimed row OR one whose claim is older than the TTL',
      actual: {
        unclaimed: alternatives?.[0]?.isNull,
        ttlSeconds: ((alternatives?.[1] as Cond)?.values?.[1] as { values?: unknown[] } | undefined)?.values?.[0],
      },
      expected: {
        unclaimed: 'ai_stream_sessions.reap_claimed_at',
        ttlSeconds: REAP_CLAIM_TTL_MS / 1000,
      },
    });
  });

  it('returns the row the claim itself read, so the reap acts on claim-time data', async () => {
    const won = await claimDeadStream({ messageId: 'msg-1' });

    assert({
      given: 'a won claim',
      should: 'carry the token, the heartbeat at claim time, and everything the materializer needs',
      actual: won,
      expected: dbRow(),
    });
  });

  it('given no matching row, answers null rather than guessing why', async () => {
    mockReturning.mockResolvedValue([]);

    assert({
      given: 'a claim that matched nothing (settled itself, fresh heartbeat, or held by a peer)',
      should: 'answer null — all three call for the same action, which is none',
      actual: await claimDeadStream({ messageId: 'msg-1' }),
      expected: null,
    });
  });

  it('refuses a claim whose token came back null', async () => {
    // Unreachable — the same statement just set the column — but a null token would make every
    // fence degrade to "match anything", which is the one failure this module exists to prevent.
    mockReturning.mockResolvedValue([dbRow({ claimedAt: null })]);

    assert({
      given: 'a claim returning a null token',
      should: 'refuse the reap',
      actual: await claimDeadStream({ messageId: 'msg-1' }),
      expected: null,
    });
  });

  it('never throws — a failed claim is a reap the next sweep retries', async () => {
    mockReturning.mockRejectedValue(new Error('db down'));

    assert({
      given: 'a claim statement that threw',
      should: 'answer null instead of taking down the batch loop the caller runs it in',
      actual: await claimDeadStream({ messageId: 'msg-1' }),
      expected: null,
    });
  });
});

describe('reapClaimFence — the predicate every destructive write carries', () => {
  it('requires the claim token AND that the owner has not beaten since', async () => {
    const built = conds(reapClaimFence(claim()));

    // Both clauses are load-bearing. The token catches a superseded claim; the heartbeat bound
    // catches the case the claim itself cannot — an owner that was never dead and beat AFTER
    // the claim committed. Without the second, the claim would be a lock taken against a live
    // process.
    assert({
      given: 'a fence built from a won claim',
      should: 'pin the row, its streaming status, the exact claim token, and the heartbeat ceiling',
      actual: {
        messageId: built.find((c) => c.field === 'ai_stream_sessions.message_id')?.value,
        status: built.find((c) => c.field === 'ai_stream_sessions.status')?.value,
        token: built.find((c) => c.field === 'ai_stream_sessions.reap_claimed_at')?.value,
        heartbeatBound: built.find((c) => c.field === 'ai_stream_sessions.last_heartbeat_at')?.lteValue,
      },
      expected: {
        messageId: 'msg-1',
        status: 'streaming',
        token: CLAIMED_AT,
        heartbeatBound: HEARTBEAT_AT,
      },
    });
  });
});

describe('isReapClaimStillHeld — the frame delete\'s stand-in fence', () => {
  it('given the fenced row still present, answers true', async () => {
    assert({
      given: 'a claim whose row still matches the fence',
      should: 'permit the frame delete',
      actual: await isReapClaimStillHeld(claim()),
      expected: true,
    });
  });

  it('given no matching row, answers false', async () => {
    mockSelectLimit.mockResolvedValue([]);

    // `ai_stream_frames` carries none of the session row's columns, so the frame DELETE cannot
    // carry the fence in its own WHERE clause. This read stands in for it.
    assert({
      given: 'a claim that no longer matches its row',
      should: 'refuse the frame delete',
      actual: await isReapClaimStillHeld(claim()),
      expected: false,
    });
  });

  it('fails CLOSED when the check itself cannot run', async () => {
    mockSelectLimit.mockRejectedValue(new Error('db down'));

    // A DB blip must skip the release rather than perform it blind: the frames then linger
    // until the retention backstop reclaims them, which is the cheap direction to be wrong in.
    assert({
      given: 'a claim verification that threw',
      should: 'answer false',
      actual: await isReapClaimStillHeld(claim()),
      expected: false,
    });
  });
});
