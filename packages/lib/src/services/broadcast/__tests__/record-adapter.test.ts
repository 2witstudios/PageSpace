/**
 * The durable ledger's rules, which are the difference between "resumed" and
 * "emailed everyone twice".
 *
 * The database is mocked, so what these pin is the CONTRACT the adapter asks Postgres to
 * enforce: which conflict target it upserts against, which writes refuse to demote a
 * completed send, and which failures are fatal versus swallowed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

interface InsertCall {
  table: unknown;
  values?: Record<string, unknown>;
  conflict?: { target: unknown; set: Record<string, unknown>; setWhere?: SQL };
}

const insertCalls: InsertCall[] = [];
/** Table name → error, so a test can fail the ledger write and the analytics write apart. */
const insertFailures = new Map<string, Error>();
let selectRows: unknown[] = [];
/** What a claim's `.returning()` hands back: a row means the claim won. */
let returningRows: unknown[] = [];

function tableName(table: unknown): string {
  return table === broadcastRecipients ? 'recipients' : 'log';
}

function makeInsertChain(table: unknown) {
  const call: InsertCall = { table };
  insertCalls.push(call);

  const chain = {
    values: (values: Record<string, unknown>) => {
      call.values = values;
      return chain;
    },
    onConflictDoUpdate: (conflict: InsertCall['conflict']) => {
      call.conflict = conflict;
      return chain;
    },
    returning: () => ({
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        const failure = insertFailures.get(tableName(table));
        return failure
          ? Promise.reject(failure).then(resolve, reject)
          : Promise.resolve(returningRows).then(resolve, reject);
      },
    }),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      const failure = insertFailures.get(tableName(table));
      return failure
        ? Promise.reject(failure).then(resolve, reject)
        : Promise.resolve(undefined).then(resolve, reject);
    },
  };
  return chain;
}

function makeSelectChain() {
  const chain = {
    from: () => chain,
    where: () => chain,
    groupBy: () => chain,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(selectRows).then(resolve, reject),
  };
  return chain;
}

interface UpdateCall {
  table: unknown;
  set?: Record<string, unknown>;
}
const updateCalls: UpdateCall[] = [];
let updateShouldThrow: Error | null = null;

function makeUpdateChain(table: unknown) {
  const call: UpdateCall = { table };
  updateCalls.push(call);
  const chain = {
    set: (set: Record<string, unknown>) => {
      call.set = set;
      return chain;
    },
    where: () => chain,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      updateShouldThrow
        ? Promise.reject(updateShouldThrow).then(resolve, reject)
        : Promise.resolve(undefined).then(resolve, reject),
  };
  return chain;
}

vi.mock('@pagespace/db/db', () => ({
  db: {
    insert: vi.fn((table: unknown) => makeInsertChain(table)),
    select: vi.fn(() => makeSelectChain()),
    update: vi.fn((table: unknown) => makeUpdateChain(table)),
  },
}));

import { broadcastRecipients } from '@pagespace/db/schema/email-broadcasts';
import { emailNotificationLog } from '@pagespace/db/schema/email-notifications';
import { LedgerWriteFailed } from '../core';
import {
  CLAIM_LEASE_MS,
  claimRecipient,
  countRecipientsByStatus,
  loadAlreadySentEmails,
  loadAlreadySentUserIds,
  recordFailure,
  recordSent,
  recordSkip,
} from '../record-adapter';

const entry = { email: 'ada@example.com', userId: 'u1', sentAt: '2026-07-16T00:00:00.000Z' };

/** The compiled text of a captured setWhere clause. */
function setWhereSql(call: InsertCall): string {
  if (!call.conflict?.setWhere) throw new Error('no setWhere captured');
  return new PgDialect().sqlToQuery(call.conflict.setWhere).sql;
}

/** The compiled params a captured setWhere bound. */
function setWhereParams(call: InsertCall): unknown[] {
  if (!call.conflict?.setWhere) throw new Error('no setWhere captured');
  return new PgDialect().sqlToQuery(call.conflict.setWhere).params;
}

/** Compile an arbitrary SQL fragment (e.g. a value the insert bound). */
function compile(fragment: unknown): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(fragment as SQL);
}

const recipientInserts = () => insertCalls.filter((c) => c.table === broadcastRecipients);
const logInserts = () => insertCalls.filter((c) => c.table === emailNotificationLog);

beforeEach(() => {
  insertCalls.length = 0;
  insertFailures.clear();
  updateCalls.length = 0;
  updateShouldThrow = null;
  selectRows = [];
  returningRows = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('claimRecipient', () => {
  // The claim is what actually prevents a double-send: the unique constraint only
  // coalesces the ledger AFTER both workers have already handed mail to the provider.
  // These pin the predicate that decides which of two racing workers gets the recipient.

  it('given a row came back, should report the recipient claimed', async () => {
    returningRows = [{ id: 'r1' }];
    expect(await claimRecipient('b1', { userId: 'u1', email: 'ada@example.com' })).toBe(true);
  });

  it('given no row came back, should report the recipient NOT claimed', async () => {
    // The conflict path's WHERE rejected the update: someone else owns them, or they were
    // already mailed. Either way this worker must not send.
    returningRows = [];
    expect(await claimRecipient('b1', { userId: 'u1', email: 'ada@example.com' })).toBe(false);
  });

  it("should insert a pending row stamped with the DATABASE's clock", async () => {
    returningRows = [{ id: 'r1' }];
    await claimRecipient('b1', { userId: 'u1', email: 'ada@example.com' });

    expect(recipientInserts()[0].values).toMatchObject({
      broadcastId: 'b1',
      userId: 'u1',
      status: 'pending',
    });
    // Not `new Date()`. A lease stamped by one process and judged by another is only as
    // good as the agreement between their clocks; six minutes of skew is enough for two
    // workers to both mail the same person. Postgres's clock is the only one here.
    const { sql } = compile(recipientInserts()[0].values?.claimedAt);
    expect(sql).toContain('now()');
    expect(sql).toContain("at time zone 'utc'");
  });

  it('should upsert against the (broadcastId, userId) unique constraint', async () => {
    returningRows = [{ id: 'r1' }];
    await claimRecipient('b1', { userId: 'u1', email: 'ada@example.com' });

    expect(recipientInserts()[0].conflict?.target).toEqual([
      broadcastRecipients.broadcastId,
      broadcastRecipients.userId,
    ]);
  });

  it('should refuse to reclaim a recipient already sent', async () => {
    returningRows = [{ id: 'r1' }];
    await claimRecipient('b1', { userId: 'u1', email: 'ada@example.com' });

    // The backstop for when the resume set was read before a rival's send landed.
    expect(setWhereSql(recipientInserts()[0])).toContain('"broadcast_recipients"."status" <>');
    expect(setWhereParams(recipientInserts()[0])).toContain('sent');
  });

  it('should refuse to steal a recipient whose lease is still fresh', async () => {
    returningRows = [{ id: 'r1' }];
    await claimRecipient('b1', { userId: 'u1', email: 'ada@example.com' });

    // `claimed_at is null or claimed_at < <lease floor>` — a rival's fresh stamp fails it,
    // which is what makes exactly one of two racing workers win.
    const sql = setWhereSql(recipientInserts()[0]);
    expect(sql).toContain('"broadcast_recipients"."claimed_at" is null');
    expect(sql).toContain('"broadcast_recipients"."claimed_at" <');
  });

  it('should RELEASE the lease when a send fails, so a prompt retry is not a no-op', async () => {
    // A terminal outcome must not keep holding the recipient: after a provider blip, every
    // failed row refusing to be reclaimed for ~5m would make the retry mail nobody while
    // logging "claimed by another worker" about a worker that does not exist.
    await recordFailure('b1', { userId: 'u1', email: 'ada@example.com', error: 'rate limited' });

    expect(recipientInserts()[0].conflict?.set).toMatchObject({ claimedAt: null });
  });

  it('should reclaim a recipient whose worker crashed and let the lease expire', async () => {
    // Without this a mid-send crash would strand the recipient as `pending` forever and
    // nobody would ever mail them. The expiry is measured against the database's clock —
    // `now() - make_interval(...)` — so the lease arrives as seconds, not as an instant
    // computed here.
    returningRows = [{ id: 'r1' }];
    await claimRecipient('b1', { userId: 'u1', email: 'ada@example.com' }, { leaseMs: 60_000 });

    const call = recipientInserts()[0];
    expect(setWhereSql(call)).toContain('make_interval');
    expect(setWhereParams(call)).toContain(60);
  });

  it('should default to the shared lease when none is given', async () => {
    returningRows = [{ id: 'r1' }];
    await claimRecipient('b1', { userId: 'u1', email: 'ada@example.com' });

    expect(setWhereParams(recipientInserts()[0])).toContain(CLAIM_LEASE_MS / 1000);
  });

  it("should judge the lease on the database's clock, never the caller's", async () => {
    // No timestamp computed in this process may appear in the comparison, or two workers
    // with skewed clocks disagree about who owns a recipient — and both mail them.
    returningRows = [{ id: 'r1' }];
    await claimRecipient('b1', { userId: 'u1', email: 'ada@example.com' });

    const call = recipientInserts()[0];
    expect(setWhereSql(call)).toContain('now()');
    const boundTimestamps = setWhereParams(call).filter(
      (p) => p instanceof Date || (typeof p === 'string' && p.includes('T') && !Number.isNaN(Date.parse(p))),
    );
    expect(boundTimestamps).toEqual([]);
  });

  it('should count the attempt, so a recipient retried forever is visible', async () => {
    returningRows = [{ id: 'r1' }];
    await claimRecipient('b1', { userId: 'u1', email: 'ada@example.com' });

    expect(recipientInserts()[0].conflict?.set).toHaveProperty('attempts');
  });
});

describe('recordSent', () => {
  it('should upsert against the (broadcastId, userId) unique constraint', async () => {
    // That constraint IS the idempotency backbone: two workers racing one recipient must
    // produce one row, not two sends.
    await recordSent('b1', entry, 'PRODUCT_UPDATE');

    const [call] = recipientInserts();
    expect(call.conflict?.target).toEqual([broadcastRecipients.broadcastId, broadcastRecipients.userId]);
    expect(call.values).toMatchObject({ broadcastId: 'b1', userId: 'u1', status: 'sent' });
  });

  it('should promote a prior failed or pending attempt to sent', async () => {
    await recordSent('b1', entry, 'PRODUCT_UPDATE');

    const [call] = recipientInserts();
    expect(call.conflict?.set).toMatchObject({ status: 'sent', errorMessage: null, skipReason: null });
  });

  it('should not re-count an attempt the claim already counted', async () => {
    // A durable send is always claim -> send -> record, and the claim owns `attempts`.
    // Incrementing here too would report 2 attempts for a clean first-try send.
    await recordSent('b1', entry, 'PRODUCT_UPDATE');

    expect(recipientInserts()[0].conflict?.set).not.toHaveProperty('attempts');
  });

  it('given a ledger write failure, should throw LedgerWriteFailed — the email is already gone', async () => {
    // The one fatal case: the recipient has the email and nothing remembers it, so the
    // run must stop rather than re-mail them on the next retry.
    insertFailures.set('recipients', new Error('deadlock detected'));

    await expect(recordSent('b1', entry, 'PRODUCT_UPDATE')).rejects.toBeInstanceOf(LedgerWriteFailed);
  });

  it('the fatal error should carry the entry an operator would have to reconstruct', async () => {
    insertFailures.set('recipients', new Error('deadlock detected'));
    await expect(recordSent('b1', entry, 'PRODUCT_UPDATE')).rejects.toMatchObject({ entry });
  });

  it('given the send could not be recorded, should PARK the claim so no retry re-sends', async () => {
    // The file ledger was safe by default here — nothing re-sent until a human re-ran. A
    // lease is not: left alone it expires and an automatic retry mails a second copy. So
    // the row is parked under a lease nobody can steal, restoring "nothing happens until
    // someone looks at it".
    insertFailures.set('recipients', new Error('connection terminated'));

    await expect(recordSent('b1', entry, 'PRODUCT_UPDATE')).rejects.toBeInstanceOf(LedgerWriteFailed);

    expect(updateCalls).toHaveLength(1);
    const { sql } = compile(updateCalls[0].set?.claimedAt);
    expect(sql).toContain('now()');
    expect(sql).toContain('100 years');
  });

  it('given the park ALSO fails, should still raise the original ledger failure', async () => {
    // The park is best-effort: the write that just failed may be the same write failing
    // again. What the operator must not lose is the error naming the unrecorded send.
    insertFailures.set('recipients', new Error('connection terminated'));
    updateShouldThrow = new Error('still down');

    await expect(recordSent('b1', entry, 'PRODUCT_UPDATE')).rejects.toBeInstanceOf(LedgerWriteFailed);
  });

  it('the remediation should name broadcast_recipients, not the script\'s JSONL ledger', async () => {
    // An instruction pointing at storage the operator is not using is worse than none.
    insertFailures.set('recipients', new Error('connection terminated'));

    await expect(recordSent('b1', entry, 'PRODUCT_UPDATE')).rejects.toThrow(/insert into broadcast_recipients/);
  });

  it('should also write a secondary analytics row', async () => {
    await recordSent('b1', entry, 'PRODUCT_UPDATE');

    expect(logInserts()[0]?.values).toMatchObject({
      userId: 'u1',
      recipientEmail: 'ada@example.com',
      notificationType: 'PRODUCT_UPDATE',
      success: true,
    });
  });

  it('given the analytics write fails, should NOT fail the send', async () => {
    // The send succeeded and IS recorded in the ledger. Failing the broadcast over an
    // append-only analytics row would trade a real outcome for a bookkeeping detail.
    insertFailures.set('log', new Error('log table gone'));

    await expect(recordSent('b1', entry, 'PRODUCT_UPDATE')).resolves.toBeUndefined();
    // ...and the ledger row still went in, which is what a resume reads.
    expect(recipientInserts()[0].values).toMatchObject({ status: 'sent' });
  });
});

describe('recordSkip', () => {
  it('should record why the recipient was declined', async () => {
    await recordSkip('b1', { userId: 'u1', email: 'ada@example.com', reason: 'opted-out' });

    const [call] = recipientInserts();
    expect(call.values).toMatchObject({ status: 'skipped', skipReason: 'opted-out' });
  });

  it('should never demote a completed send to skipped', async () => {
    // On a resumed run every already-mailed recipient decides as `already-sent`. Without
    // this guard the resume would erase the rows that make it a resume.
    await recordSkip('b1', { userId: 'u1', email: 'ada@example.com', reason: 'already-sent' });

    expect(setWhereSql(recipientInserts()[0])).toContain("<> 'sent'");
  });

  it('given a write failure, should swallow it — a lost skip note cannot double-send', async () => {
    insertFailures.set('recipients', new Error('db down'));
    await expect(
      recordSkip('b1', { userId: 'u1', email: 'ada@example.com', reason: 'opted-out' }),
    ).resolves.toBeUndefined();
  });

  it('given a user with no readable address, should still record the skip', async () => {
    await recordSkip('b1', { userId: 'u1', email: null, reason: 'invalid-email' });
    expect(recipientInserts()[0].values).toMatchObject({ recipientEmail: '', skipReason: 'invalid-email' });
  });
});

describe('recordFailure', () => {
  it('should record the error as failed, never sent, so a retry picks it up', async () => {
    await recordFailure('b1', { userId: 'u1', email: 'ada@example.com', error: 'rate limited' });

    const [call] = recipientInserts();
    expect(call.values).toMatchObject({ status: 'failed', errorMessage: 'rate limited' });
    expect(call.conflict?.set).toMatchObject({ status: 'failed' });
  });

  it('should never unmark a real send', async () => {
    await recordFailure('b1', { userId: 'u1', email: 'ada@example.com', error: 'late error' });
    expect(setWhereSql(recipientInserts()[0])).toContain("<> 'sent'");
  });

  it('should not re-count an attempt the claim already counted', async () => {
    await recordFailure('b1', { userId: 'u1', email: 'ada@example.com', error: 'rate limited' });
    expect(recipientInserts()[0].conflict?.set).not.toHaveProperty('attempts');
  });

  it('given a write failure, should swallow it — the email did not go out', async () => {
    insertFailures.set('recipients', new Error('db down'));
    await expect(
      recordFailure('b1', { userId: 'u1', email: 'ada@example.com', error: 'rate limited' }),
    ).resolves.toBeUndefined();
  });
});

describe('loadAlreadySentUserIds', () => {
  it('should build the resume set from sent rows', async () => {
    selectRows = [{ userId: 'u1' }, { userId: 'u2' }];
    expect(await loadAlreadySentUserIds('b1')).toEqual(new Set(['u1', 'u2']));
  });

  it('given an erased user, should have no row to read at all', async () => {
    // `userId` is notNull and CASCADEs (matching email_notification_log): erasing the user
    // erases the record that we mailed them, rather than leaving their plaintext address
    // behind in a row nothing can reach. So there is no null id to filter — and notNull
    // also means the UNIQUE(broadcastId, userId) has no NULL hole for two rows to slip
    // through, since Postgres treats NULLs as distinct.
    selectRows = [{ userId: 'u1' }];
    expect(await loadAlreadySentUserIds('b1')).toEqual(new Set(['u1']));
  });
});

describe('loadAlreadySentEmails', () => {
  it('should normalize addresses, so two accounts sharing one address are mailed once', async () => {
    selectRows = [{ recipientEmail: ' Ada@Example.com ' }, { recipientEmail: 'grace@example.com' }];
    expect(await loadAlreadySentEmails('b1')).toEqual(new Set(['ada@example.com', 'grace@example.com']));
  });
});

describe('countRecipientsByStatus', () => {
  it('should report every status, including the ones with no rows', async () => {
    selectRows = [
      { status: 'sent', value: 5 },
      { status: 'skipped', value: 2 },
    ];
    expect(await countRecipientsByStatus('b1')).toEqual({ pending: 0, sent: 5, skipped: 2, failed: 0 });
  });
});