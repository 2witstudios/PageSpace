import { describe, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { assert } from './riteway';
import { db } from '@pagespace/db/db';
import { eq, sql } from '@pagespace/db/operators';
import { aiStreamSessions } from '@pagespace/db/schema/ai-streams';
import { conversations } from '@pagespace/db/schema/conversations';
import { users } from '@pagespace/db/schema/auth';
import { ensureTestDb } from '@/test/ensure-test-db';
import { claimDeadStream, reapClaimFence, isReapClaimStillHeld } from '../stream-reap-claim';

/**
 * THE REAL DATABASE, DELIBERATELY — because the bug this file exists to prevent is INVISIBLE
 * to a mocked one.
 *
 * `stream-reap-claim.test.ts` mocks the driver and asserts on the predicate shapes, which is
 * the right way to pin "does the WHERE clause say what it should". It cannot pin the thing
 * that actually broke: the claim token is a `timestamp`, PostgreSQL keeps it at MICROSECOND
 * precision, and the driver hands it back as a JavaScript `Date`, which holds only
 * MILLISECONDS. Binding that truncated value into the fence's equality compared `…06.556`
 * against a stored `…06.556568` and matched ZERO rows — so every fenced settle and every frame
 * release was rejected, the row never left `'streaming'`, and the reap retried forever. The
 * shipped predicate was correct; the round trip through the type system was not, and only a
 * real round trip can see the difference (review finding — chatgpt-codex-connector, PR #2419).
 *
 * That is the general rule these cases are here to enforce: anything whose correctness depends
 * on how a VALUE survives the trip to Postgres and back belongs in this file, and anything that
 * depends on the SHAPE of a statement belongs in the unit suite next door.
 */

const CONVERSATION_ID = 'reap-claim-it-conv';
const USER_ID = 'reap-claim-it-user';

const minutesAgo = (n: number): Date => new Date(Date.now() - n * 60 * 1000);

/** A row eligible for reaping unless a case says otherwise: streaming, long since silent. */
const seedRow = async (messageId: string, over: Record<string, unknown> = {}): Promise<void> => {
  await db.delete(aiStreamSessions).where(eq(aiStreamSessions.messageId, messageId));
  await db.insert(aiStreamSessions).values({
    messageId,
    channelId: 'page-reap-claim-it',
    conversationId: CONVERSATION_ID,
    userId: USER_ID,
    status: 'streaming',
    startedAt: minutesAgo(10),
    lastHeartbeatAt: minutesAgo(10),
    parts: [{ type: 'text', text: 'partial' }],
    rawPartsCount: 3,
    ...over,
  } as never);
};

const readRow = async (messageId: string) => {
  const [row] = await db
    .select({
      status: aiStreamSessions.status,
      reapClaimedAt: aiStreamSessions.reapClaimedAt,
      completedAt: aiStreamSessions.completedAt,
    })
    .from(aiStreamSessions)
    .where(eq(aiStreamSessions.messageId, messageId))
    .limit(1);
  return row;
};

/** The settle exactly as `materializeInterruptedStream` issues it. */
const fencedSettle = async (claim: Parameters<typeof reapClaimFence>[0]) => {
  const result = await db
    .update(aiStreamSessions)
    .set({ status: 'aborted', completedAt: new Date(), parts: [], rawPartsCount: 0 })
    .where(reapClaimFence(claim));
  return result.rowCount ?? 0;
};

beforeAll(async () => {
  await ensureTestDb();
  // The FK chain these rows hang off: users ← conversations ← ai_stream_sessions. Seeded here
  // rather than assumed, so this file is self-contained against a freshly migrated database.
  await db
    .insert(users)
    .values({ id: USER_ID, name: 'Reap Claim IT', email: 'reap-claim-it@example.test' } as never)
    .onConflictDoNothing();
  // `ai_stream_sessions.conversation_id` is a real FK with ON DELETE CASCADE (migration 0250),
  // so the parent row has to exist before any of this.
  // `type: 'page'` carries a CHECK requiring `contextId`
  // (conversations_page_context_present_chk) — the page the conversation hangs off.
  await db
    .insert(conversations)
    .values({
      id: CONVERSATION_ID,
      userId: USER_ID,
      type: 'page',
      contextId: 'page-reap-claim-it',
    } as never)
    .onConflictDoNothing();
});

afterAll(async () => {
  // CASCADE takes the session rows with it.
  await db.delete(conversations).where(eq(conversations.id, CONVERSATION_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

beforeEach(async () => {
  await db.delete(aiStreamSessions).where(eq(aiStreamSessions.conversationId, CONVERSATION_ID));
});

describe('reap claim — the token survives the round trip to Postgres and back', () => {
  it('given a won claim, the fence it builds matches its own row', async () => {
    // THE REGRESSION GUARD. If the token is ever stored at a precision the driver cannot
    // represent, this is 0 and the entire reap path silently stops working in production while
    // every mocked test stays green.
    await seedRow('msg-token');

    const claim = await claimDeadStream({ messageId: 'msg-token' });
    const matched = claim === null ? -1 : await fencedSettle(claim);

    assert({
      given: 'a claim taken and then used as its own fence',
      should: 'match exactly the one row it claimed',
      actual: matched,
      expected: 1,
    });
  });

  it('given a won claim, the frame-release check agrees with the fence', async () => {
    await seedRow('msg-held');

    const claim = await claimDeadStream({ messageId: 'msg-held' });
    const held = claim === null ? false : await isReapClaimStillHeld(claim);

    // The frame DELETE targets a different table and cannot carry the fence in its own WHERE
    // clause, so this read stands in for it. If it disagreed with `reapClaimFence`, frames
    // would leak on every reap (or, worse, be deleted when the fence would have refused).
    assert({
      given: 'a freshly won claim',
      should: 'still be held',
      actual: held,
      expected: true,
    });
  });

  it('stores the token at a precision a JavaScript Date can represent exactly', async () => {
    await seedRow('msg-precision');

    const claim = await claimDeadStream({ messageId: 'msg-precision' });
    const result = await db.execute(
      sql`select reap_claimed_at::text as t from ai_stream_sessions where message_id = 'msg-precision'`,
    );
    const stored = (result as unknown as { rows: { t: string }[] }).rows[0].t;
    // e.g. `2026-08-15 22:08:06.556` — everything after the last dot.
    const fractional = stored.includes('.') ? stored.slice(stored.lastIndexOf('.') + 1) : '';

    // Stated as its own case so a failure names the CAUSE rather than only the symptom above.
    // A bare `now()` yields `22:08:06.556568` — six digits, three of which a JS Date silently
    // drops on the way back, which is what made the fence match nothing.
    assert({
      given: 'the stored claim token',
      should: 'carry no sub-millisecond digits for the driver to lose',
      actual: fractional.length <= 3,
      expected: true,
    });

    // Compared as milliseconds-within-the-second rather than as absolute instants: the column
    // is `timestamp without time zone`, so reconstructing an absolute time from its text form
    // would test this machine's timezone rather than the precision this case is about.
    assert({
      given: 'the token the claim returned',
      should: 'carry the same sub-second value the database stored',
      actual: claim === null ? null : claim.claimedAt.getMilliseconds(),
      expected: Number(fractional.padEnd(3, '0')),
    });
  });
});

describe('reap claim — the predicate, evaluated by Postgres', () => {
  it('refuses a row whose heartbeat is fresh', async () => {
    await seedRow('msg-alive', { lastHeartbeatAt: new Date() });

    assert({
      given: 'a stream that is still beating',
      should: 'not be claimable, however dead the caller believed it was',
      actual: await claimDeadStream({ messageId: 'msg-alive' }),
      expected: null,
    });
  });

  it('refuses a row that has already left streaming', async () => {
    await seedRow('msg-done', { status: 'complete' });

    assert({
      given: 'a settled row',
      should: 'not be claimable',
      actual: await claimDeadStream({ messageId: 'msg-done' }),
      expected: null,
    });
  });

  it('gives the claim to exactly ONE of two concurrent reapers', async () => {
    await seedRow('msg-contended');

    // The N>1 case, run for real: two claims racing the same row. READ COMMITTED makes the
    // loser re-evaluate its WHERE against the updated tuple, where `reap_claimed_at` is now
    // fresh, so it matches nothing.
    const [a, b] = await Promise.all([
      claimDeadStream({ messageId: 'msg-contended' }),
      claimDeadStream({ messageId: 'msg-contended' }),
    ]);

    assert({
      given: 'two instances sweeping the same dead row at once',
      should: 'let exactly one win',
      actual: [a, b].filter((c) => c !== null).length,
      expected: 1,
    });
  });

  it('refuses a second claim while the first is unexpired', async () => {
    await seedRow('msg-claimed');

    const first = await claimDeadStream({ messageId: 'msg-claimed' });
    const second = await claimDeadStream({ messageId: 'msg-claimed' });

    assert({
      given: 'a row already claimed moments ago',
      should: 'refuse the second reaper while the claim holds',
      actual: { firstWon: first !== null, secondWon: second !== null },
      expected: { firstWon: true, secondWon: false },
    });
  });

  it('re-claims a row whose holder died mid-reap', async () => {
    // The TTL is what stops a crashed reaper wedging the row forever — and the row staying
    // `'streaming'` throughout is what makes the retry possible at all.
    await seedRow('msg-abandoned', { reapClaimedAt: minutesAgo(5) });

    const claim = await claimDeadStream({ messageId: 'msg-abandoned' });

    assert({
      given: 'a claim older than its TTL',
      should: 'be re-claimable by the next sweep',
      actual: claim !== null,
      expected: true,
    });
  });
});

describe('reap claim — the fence, against a live owner', () => {
  it('rejects the settle when a heartbeat lands after the claim', async () => {
    await seedRow('msg-revived');
    const claim = await claimDeadStream({ messageId: 'msg-revived' });

    // The owner was never dead — a DB stall cleared, or a paused machine resumed — and beats
    // again between the claim committing and the destructive write. This is the exact race the
    // heartbeat half of the fence exists for, and the one a `status='streaming'` CAS cannot
    // catch: a live owner has not changed its status.
    await db
      .update(aiStreamSessions)
      .set({ lastHeartbeatAt: new Date() })
      .where(eq(aiStreamSessions.messageId, 'msg-revived'));

    const matched = claim === null ? -1 : await fencedSettle(claim);
    const row = await readRow('msg-revived');

    assert({
      given: 'an owner that beat again after the claim was taken',
      should: 'match no rows and leave the stream streaming, joinable and Stoppable',
      actual: { matched, status: row?.status },
      expected: { matched: 0, status: 'streaming' },
    });
  });

  it('rejects the settle when another reaper takes the claim over', async () => {
    await seedRow('msg-stolen', { reapClaimedAt: minutesAgo(5) });
    const stale = await claimDeadStream({ messageId: 'msg-stolen' });

    // Simulate the TTL expiring and a second sweep winning it.
    await db
      .update(aiStreamSessions)
      .set({ reapClaimedAt: sql`date_trunc('milliseconds', (now() at time zone 'utc') + interval '1 second')` })
      .where(eq(aiStreamSessions.messageId, 'msg-stolen'));

    const matched = stale === null ? -1 : await fencedSettle(stale);

    assert({
      given: 'a claim that has been superseded',
      should: 'match no rows',
      actual: matched,
      expected: 0,
    });
  });

  it('rejects the frame release when the claim no longer holds', async () => {
    await seedRow('msg-release');
    const claim = await claimDeadStream({ messageId: 'msg-release' });

    await db
      .update(aiStreamSessions)
      .set({ lastHeartbeatAt: new Date() })
      .where(eq(aiStreamSessions.messageId, 'msg-release'));

    assert({
      given: 'a live owner and a stale claim',
      should: 'refuse to delete the frame log it is still writing',
      actual: claim === null ? null : await isReapClaimStillHeld(claim),
      expected: false,
    });
  });

  it('a won claim settles the row exactly once', async () => {
    await seedRow('msg-once');
    const claim = await claimDeadStream({ messageId: 'msg-once' });
    if (claim === null) throw new Error('expected a claim');

    const first = await fencedSettle(claim);
    const second = await fencedSettle(claim);
    const row = await readRow('msg-once');

    // The second attempt is what a retried sweep looks like. `status='streaming'` rides the
    // fence, so a settled row cannot be relabelled by a replay of its own reap.
    assert({
      given: 'the same fence applied twice',
      should: 'settle once and then match nothing',
      actual: { first, second, status: row?.status },
      expected: { first: 1, second: 0, status: 'aborted' },
    });
  });
});

describe('reap claim — what RETURNING hands the materializer', () => {
  it('carries the row as it stood when the claim was won', async () => {
    await seedRow('msg-returning');

    const claim = await claimDeadStream({ messageId: 'msg-returning' });

    // The whole reason the claim projects wide: this is what the materializer acts on, and it
    // comes from the same statement that fenced the write rather than from a read taken
    // seconds earlier by a caller on a different machine.
    assert({
      given: 'a won claim',
      should: 'carry the channel, conversation, owner, snapshot and start time',
      actual: claim === null ? null : {
        messageId: claim.messageId,
        channelId: claim.channelId,
        conversationId: claim.conversationId,
        userId: claim.userId,
        rawPartsCount: claim.rawPartsCount,
        parts: claim.parts,
        hasStartedAt: claim.startedAt instanceof Date,
        heartbeatBeforeClaim: claim.heartbeatAtClaim.getTime() < claim.claimedAt.getTime(),
      },
      expected: {
        messageId: 'msg-returning',
        channelId: 'page-reap-claim-it',
        conversationId: CONVERSATION_ID,
        userId: USER_ID,
        rawPartsCount: 3,
        parts: [{ type: 'text', text: 'partial' }],
        hasStartedAt: true,
        heartbeatBeforeClaim: true,
      },
    });
  });

  it('given a messageId with no row, answers null', async () => {
    assert({
      given: 'a stream that does not exist',
      should: 'answer null rather than throwing into the caller\'s batch loop',
      actual: await claimDeadStream({ messageId: 'msg-nonexistent' }),
      expected: null,
    });
  });
});

/**
 * The heartbeat comparison is the other value that crosses the type boundary, and it crosses it
 * the OTHER way: written from JavaScript, compared in SQL.
 */
describe('reap claim — staleness is measured on the database clock', () => {
  it('claims a row whose heartbeat is just past the horizon and refuses one just inside it', async () => {
    await seedRow('msg-just-stale', { lastHeartbeatAt: new Date(Date.now() - 125_000) });
    await seedRow('msg-just-live', { lastHeartbeatAt: new Date(Date.now() - 115_000) });

    const stale = await claimDeadStream({ messageId: 'msg-just-stale' });
    const live = await claimDeadStream({ messageId: 'msg-just-live' });

    // Both sides of STREAM_HEARTBEAT_STALE_MS (120s), evaluated by Postgres against a JS-written
    // column. A unit interval or a timezone mismatch in the cast would move this boundary.
    assert({
      given: 'heartbeats five seconds either side of the stale horizon',
      should: 'claim the stale one and refuse the live one',
      actual: { stale: stale !== null, live: live !== null },
      expected: { stale: true, live: false },
    });
  });

  it('honours an explicit staleAfterMs', async () => {
    await seedRow('msg-custom', { lastHeartbeatAt: new Date(Date.now() - 40_000) });

    const tight = await claimDeadStream({ messageId: 'msg-custom', staleAfterMs: 30_000 });

    assert({
      given: 'a 30s horizon and a 40s-old heartbeat',
      should: 'claim it, where the 120s default would not',
      actual: tight !== null,
      expected: true,
    });
  });
});
