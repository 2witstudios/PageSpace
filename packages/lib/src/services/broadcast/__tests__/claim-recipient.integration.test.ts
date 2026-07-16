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
import { eq } from '@pagespace/db/operators';
import { claimRecipient, recordFailure } from '../record-adapter';

const broadcastId = `bc_test_${createId()}`;
const userId = `u_test_${createId()}`;

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

afterAll(async () => {
  // Recipients cascade from both parents; delete them explicitly anyway so a failure
  // mid-suite cannot leave rows behind for the next run.
  await db.delete(broadcastRecipients).where(eq(broadcastRecipients.broadcastId, broadcastId));
  await db.delete(emailBroadcasts).where(eq(emailBroadcasts.id, broadcastId));
  await db.delete(users).where(eq(users.id, userId));
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
    expect(await claimRecipient(broadcastId, { userId, email: 'ada@example.com' })).toBe(true);

    const row = await currentRow();
    expect(row.status).toBe('pending');
    expect(row.claimedAt).toBeInstanceOf(Date);
  });

  it('given a rival holding a fresh lease, should refuse the second claim', async () => {
    expect(await claimRecipient(broadcastId, { userId, email: 'ada@example.com' })).toBe(true);
    expect(await claimRecipient(broadcastId, { userId, email: 'ada@example.com' })).toBe(false);
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

    expect(results.filter(Boolean)).toHaveLength(1);
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
    expect(await claimRecipient(broadcastId, { userId, email: 'ada@example.com' })).toBe(true);

    // Age the claim past its lease rather than sleeping.
    await db
      .update(broadcastRecipients)
      .set({ claimedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(broadcastRecipients.broadcastId, broadcastId));

    expect(
      await claimRecipient(broadcastId, { userId, email: 'ada@example.com' }, { leaseMs: 60_000 }),
    ).toBe(true);
  });

  it('should never reclaim a recipient already sent, however old the lease', async () => {
    // The backstop for a worker whose resume set was read before a rival's send landed.
    await claimRecipient(broadcastId, { userId, email: 'ada@example.com' });
    await db
      .update(broadcastRecipients)
      .set({ status: 'sent', sentAt: new Date(), claimedAt: new Date(0) })
      .where(eq(broadcastRecipients.broadcastId, broadcastId));

    expect(
      await claimRecipient(broadcastId, { userId, email: 'ada@example.com' }, { leaseMs: 1 }),
    ).toBe(false);
    expect((await currentRow()).status).toBe('sent');
  });

  it('given a failed send, should release the lease so a prompt retry can re-try them', async () => {
    // The provider-blip path: without the release, every failed row would refuse to be
    // reclaimed for the rest of its lease, and a retry 30s later would mail NOBODY while
    // reporting each one as "claimed by another worker".
    await claimRecipient(broadcastId, { userId, email: 'ada@example.com' });
    await recordFailure(broadcastId, { userId, email: 'ada@example.com', error: 'rate limited' });

    expect((await currentRow()).claimedAt).toBeNull();
    // Immediately — no waiting for a lease to drain.
    expect(await claimRecipient(broadcastId, { userId, email: 'ada@example.com' })).toBe(true);
  });

  // The "parked after an unrecorded send" path is pinned in record-adapter.test.ts
  // instead: triggering a genuine ledger-write failure here would mean contriving a DB
  // fault (the upsert cannot fail on well-formed input), and a test that fakes the very
  // failure it is testing proves nothing the mocked one doesn't prove more directly.

  it('should count one attempt per worker that takes the recipient', async () => {
    await claimRecipient(broadcastId, { userId, email: 'ada@example.com' });
    expect((await currentRow()).attempts).toBe(1);

    await db
      .update(broadcastRecipients)
      .set({ claimedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(broadcastRecipients.broadcastId, broadcastId));
    await claimRecipient(broadcastId, { userId, email: 'ada@example.com' }, { leaseMs: 60_000 });

    expect((await currentRow()).attempts).toBe(2);
  });

  it('should enforce UNIQUE(broadcastId, userId) at the database, not merely in code', async () => {
    // The constraint the ledger's idempotency rests on. `user_id` is notNull precisely so
    // this has no NULL hole — Postgres treats NULLs as distinct.
    await claimRecipient(broadcastId, { userId, email: 'ada@example.com' });

    await expect(
      db.insert(broadcastRecipients).values({
        broadcastId,
        userId,
        recipientEmail: 'ada@example.com',
        status: 'pending',
      }),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('should erase a recipient row when the user is erased', async () => {
    // GDPR: recipientEmail is plaintext, so a row surviving its subject would leave a
    // readable copy of the address behind, unreachable by any erasure step.
    const doomedId = `u_test_${createId()}`;
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
