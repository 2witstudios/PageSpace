/**
 * `claimRecipient` against a REAL Postgres.
 *
 * The unit tests mock the driver and assert on the predicate the adapter emits. That pins
 * what we ASK the database for; it cannot show what the database actually DOES. And what
 * the database does under concurrency is the entire value of this function — it is the one
 * mechanism standing between this system and mailing people twice. "The SQL string looks
 * right" is not evidence that two racing workers can't both win.
 *
 * So these run the real statement against real rows and race it against itself.
 *
 * Excluded from the unit run (see vitest.config.ts) and executed by the security workflow,
 * which has a live Postgres. Locally:
 *   docker compose -f docker-compose.test.yml up -d postgres-test
 *   DATABASE_URL=postgresql://user:password@localhost:5433/pagespace_test \
 *     bun run --filter '@pagespace/lib' test:db -- src/services/broadcast/__tests__/claim-recipient.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { broadcastRecipients, emailBroadcasts } from '@pagespace/db/schema/email-broadcasts';
import { eq, inArray } from '@pagespace/db/operators';
import { claimRecipient, recordFailure } from '../record-adapter';

// Real cuid2s: the prefixed form these used to carry is not an id this system ever
// produces, and fixtures that cannot occur in production test a system we do not run.
const broadcastId = createId();
const userId = createId();

beforeAll(async () => {
  await db.insert(users).values({
    id: userId,
    email: `claim-test-${userId}@example.test`,
    name: 'Claim Test',
  });
  await db.insert(emailBroadcasts).values({
    id: broadcastId,
    subject: 'Claim integration test',
    bodyMarkdown: 'body',
    audienceDefinition: {},
  });
});

/** Users a single test made, torn down even if it threw before its own cleanup. */
const temporaryUserIds: string[] = [];

afterAll(async () => {
  // Recipients cascade from both parents; delete them explicitly anyway so a failure
  // mid-suite cannot leave rows behind for the next run. The database is shared, so a
  // leaked row is the next run's mystery, not this one's.
  await db.delete(broadcastRecipients).where(eq(broadcastRecipients.broadcastId, broadcastId));
  await db.delete(emailBroadcasts).where(eq(emailBroadcasts.id, broadcastId));
  await db.delete(users).where(inArray(users.id, [userId, ...temporaryUserIds]));
});

beforeEach(async () => {
  await db.delete(broadcastRecipients).where(eq(broadcastRecipients.broadcastId, broadcastId));
});

async function currentRow() {
  const [row] = await db
    .select()
    .from(broadcastRecipients)
    .where(eq(broadcastRecipients.broadcastId, broadcastId));
  return row;
}

describe('claimRecipient against a real database', () => {
  it('given a fresh recipient, should claim them', async () => {
    expect(await claimRecipient(broadcastId, { userId, email: 'ada@example.com' })).not.toBeNull();

    const row = await currentRow();
    expect(row.status).toBe('pending');
    expect(row.claimedAt).toBeInstanceOf(Date);
  });

  it('given a rival holding a fresh lease, should refuse the second claim', async () => {
    expect(await claimRecipient(broadcastId, { userId, email: 'ada@example.com' })).not.toBeNull();
    expect(await claimRecipient(broadcastId, { userId, email: 'ada@example.com' })).toBeNull();
  });

  it('should let exactly ONE of many concurrent workers win', async () => {
    // The property the whole design rests on, exercised the only way that proves it: fire
    // the real statement from many connections at once and count the winners. Eight, not
    // two, because the pool holds ten (db.ts `max`) — so these genuinely overlap on
    // separate connections rather than quietly serializing through one and passing
    // whether or not Postgres locks the row.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => claimRecipient(broadcastId, { userId, email: 'ada@example.com' })),
    );

    expect(results.filter((r) => r !== null)).toHaveLength(1);
    // ...and exactly one row exists, not eight.
    const rows = await db
      .select()
      .from(broadcastRecipients)
      .where(eq(broadcastRecipients.broadcastId, broadcastId));
    expect(rows).toHaveLength(1);
  });

  it('given an expired lease, should let a retry reclaim the recipient', async () => {
    // Otherwise a worker that crashed mid-send would strand this person as `pending`
    // forever and nobody would ever mail them.
    expect(await claimRecipient(broadcastId, { userId, email: 'ada@example.com' })).not.toBeNull();

    // Age the claim past its lease rather than sleeping.
    await db
      .update(broadcastRecipients)
      .set({ claimedAt: sql`(now() at time zone 'utc') - interval '10 minutes'` })
      .where(eq(broadcastRecipients.broadcastId, broadcastId));

    expect(
      await claimRecipient(broadcastId, { userId, email: 'ada@example.com' }, { leaseMs: 60_000 }),
    ).not.toBeNull();
  });

  it('should never reclaim a recipient already sent, however old the lease', async () => {
    // The backstop for a worker whose resume set was read before a rival's send landed.
    await claimRecipient(broadcastId, { userId, email: 'ada@example.com' });
    await db
      .update(broadcastRecipients)
      .set({ status: 'sent', sentAt: new Date(), claimedAt: sql`(now() at time zone 'utc') - interval '1 year'` })
      .where(eq(broadcastRecipients.broadcastId, broadcastId));

    expect(
      await claimRecipient(broadcastId, { userId, email: 'ada@example.com' }, { leaseMs: 1 }),
    ).toBeNull();
    expect((await currentRow()).status).toBe('sent');
  });

  it('given a failed send, should release the lease so a prompt retry can re-try them', async () => {
    // The provider-blip path: without the release, every failed row would refuse to be
    // reclaimed for the rest of its lease, and a retry 30s later would mail NOBODY while
    // reporting each one as "claimed by another worker".
    const lease = await claimRecipient(broadcastId, { userId, email: 'ada@example.com' });
    await recordFailure(broadcastId, { userId, email: 'ada@example.com', error: 'rate limited' }, lease);

    expect((await currentRow()).claimedAt).toBeNull();
    // Immediately — no waiting for a lease to drain.
    expect(await claimRecipient(broadcastId, { userId, email: 'ada@example.com' })).not.toBeNull();
  });

  // The "parked after an unrecorded send" path is pinned in record-adapter.test.ts
  // instead: triggering a genuine ledger-write failure here would mean contriving a DB
  // fault (the upsert cannot fail on well-formed input), and a test that fakes the very
  // failure it is testing proves nothing the mocked one doesn't prove more directly.

  it('should NOT let a stale worker revoke the lease of the one that took over', async () => {
    // The interleaving that makes an unfenced release a double-send, run for real:
    //   A claims R and calls the provider; the send hangs (sendOne has no timeout).
    //   A's lease expires. B legitimately reclaims R and starts sending.
    //   A's hung send finally errors, and A reports the failure.
    // If A's report is keyed only on (broadcastId, userId), it wipes B's lease and marks
    // the row failed while B is still in flight — and a third worker then claims R and
    // sends a second copy. A's proof no longer matches, so A must change nothing.
    const staleLease = await claimRecipient(broadcastId, { userId, email: 'ada@example.com' });
    expect(staleLease).not.toBeNull();

    // A's lease ages out; B takes over and holds a fresh one.
    await db
      .update(broadcastRecipients)
      .set({ claimedAt: sql`(now() at time zone 'utc') - interval '10 minutes'` })
      .where(eq(broadcastRecipients.broadcastId, broadcastId));
    const bLease = await claimRecipient(broadcastId, { userId, email: 'ada@example.com' }, { leaseMs: 60_000 });
    expect(bLease).not.toBeNull();

    // A's late failure report, carrying its long-dead lease.
    await recordFailure(broadcastId, { userId, email: 'ada@example.com', error: 'socket hang up' }, staleLease);

    const row = await currentRow();
    expect(row.claimedAt).not.toBeNull();                       // B's lease survived...
    expect(row.claimedBy).toBe(bLease!.token);
    expect(row.status).toBe('pending');                          // ...and B is still sending.
    // The payoff: nobody else can take the recipient out from under B.
    expect(await claimRecipient(broadcastId, { userId, email: 'ada@example.com' })).toBeNull();
  });

  it('should NOT let a stale worker unpark a recipient whose send went unrecorded', async () => {
    // The sharper version: an unfenced release also reverses the park, which exists exactly
    // for the operator re-running a day later — outside Resend's idempotency window, where
    // the second copy is real.
    const staleLease = await claimRecipient(broadcastId, { userId, email: 'ada@example.com' });

    // Another worker sent, could not record it, and parked the row — exactly as
    // parkClaimAgainstRetry does: a lease far in the future, and NO token, so there is no
    // proof anyone can present to release it.
    await db
      .update(broadcastRecipients)
      .set({ claimedAt: sql`(now() at time zone 'utc') + interval '100 years'`, claimedBy: null })
      .where(eq(broadcastRecipients.broadcastId, broadcastId));

    await recordFailure(broadcastId, { userId, email: 'ada@example.com', error: 'socket hang up' }, staleLease);

    // Still parked: the recipient has the email, and no retry may send another.
    expect((await currentRow()).claimedAt!.getTime()).toBeGreaterThan(Date.now() + 365 * 24 * 60 * 60_000);
    expect(await claimRecipient(broadcastId, { userId, email: 'ada@example.com' })).toBeNull();
  });

  it('should count one attempt per worker that takes the recipient', async () => {
    await claimRecipient(broadcastId, { userId, email: 'ada@example.com' });
    expect((await currentRow()).attempts).toBe(1);

    await db
      .update(broadcastRecipients)
      .set({ claimedAt: sql`(now() at time zone 'utc') - interval '10 minutes'` })
      .where(eq(broadcastRecipients.broadcastId, broadcastId));
    await claimRecipient(broadcastId, { userId, email: 'ada@example.com' }, { leaseMs: 60_000 });

    expect((await currentRow()).attempts).toBe(2);
  });

  it('should enforce UNIQUE(broadcastId, userId) at the database, not merely in code', async () => {
    // The constraint the ledger's idempotency rests on. `user_id` is notNull precisely so
    // this has no NULL hole — Postgres treats NULLs as distinct.
    await claimRecipient(broadcastId, { userId, email: 'ada@example.com' });

    // drizzle-orm wraps the driver error as `Failed query: ...`; the actual Postgres
    // message ("duplicate key value violates ...") is on `.cause`, not `.message`.
    await expect(
      db.insert(broadcastRecipients).values({
        broadcastId,
        userId,
        recipientEmail: 'ada@example.com',
        status: 'pending',
      }),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/duplicate key|unique/i) } });
  });

  it('should erase a recipient row when the user is erased', async () => {
    // GDPR: recipientEmail is plaintext, so a row surviving its subject would leave a
    // readable copy of the address behind, unreachable by any erasure step.
    const doomedId = createId();
    temporaryUserIds.push(doomedId);
    await db.insert(users).values({ id: doomedId, email: `doomed-${doomedId}@example.test`, name: 'Doomed' });
    await claimRecipient(broadcastId, { userId: doomedId, email: 'doomed@example.com' });

    // Find the row by its OWN id, because that is the only way this test can fail. Asking
    // "are there rows with user_id = doomed?" is answered `no` by the very thing we are
    // guarding against: `onDelete: 'set null'` would blank user_id and leave the row —
    // plaintext address and all — sitting there passing the assertion.
    const [{ id: rowId }] = await db
      .select({ id: broadcastRecipients.id })
      .from(broadcastRecipients)
      .where(eq(broadcastRecipients.userId, doomedId));

    await db.delete(users).where(eq(users.id, doomedId));

    const survivors = await db
      .select({ id: broadcastRecipients.id, email: broadcastRecipients.recipientEmail })
      .from(broadcastRecipients)
      .where(eq(broadcastRecipients.id, rowId));
    expect(survivors).toEqual([]);
  });
});
