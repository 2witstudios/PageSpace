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

vi.mock('@pagespace/db/db', () => ({
  db: {
    insert: vi.fn((table: unknown) => makeInsertChain(table)),
    select: vi.fn(() => makeSelectChain()),
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

/**
 * The lease floor the claim bound into its `claimed_at <` comparison.
 *
 * Bound as an ISO string, not a Date: the timestamp column's driver mapper serializes it
 * on the way in.
 */
function capturedLeaseFloor(): Date {
  const stamps = setWhereParams(recipientInserts()[0]).filter(
    (p): p is string => typeof p === 'string' && p.includes('T') && !Number.isNaN(Date.parse(p)),
  );
  if (stamps.length !== 1) throw new Error(`expected one bound timestamp, got ${stamps.length}`);
  return new Date(stamps[0]);
}

const recipientInserts = () => insertCalls.filter((c) => c.table === broadcastRecipients);
const logInserts = () => insertCalls.filter((c) => c.table === emailNotificationLog);

beforeEach(() => {
  insertCalls.length = 0;
  insertFailures.clear();
  selectRows = [];
  returningRows = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
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

  it('should insert a pending row stamped with the claim time', async () => {
    returningRows = [{ id: 'r1' }];
    await claimRecipient('b1', { userId: 'u1', email: 'ada@example.com' });

    expect(recipientInserts()[0].values).toMatchObject({
      broadcastId: 'b1',
      userId: 'u1',
      status: 'pending',
    });
    expect(recipientInserts()[0].values?.claimedAt).toBeInstanceOf(Date);
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

  it('should reclaim a recipient whose worker crashed and let the lease expire', async () => {
    // Without this a mid-send crash would strand the recipient as `pending` forever and
    // nobody would ever mail them.
    returningRows = [{ id: 'r1' }];
    const before = Date.now();
    await claimRecipient('b1', { userId: 'u1', email: 'ada@example.com' }, { leaseMs: 60_000 });

    const floor = capturedLeaseFloor();
    expect(floor.getTime()).toBeGreaterThanOrEqual(before - 60_000 - 1_000);
    expect(floor.getTime()).toBeLessThanOrEqual(Date.now() - 60_000 + 1_000);
  });

  it('should default to the shared lease when none is given', async () => {
    returningRows = [{ id: 'r1' }];
    const before = Date.now();
    await claimRecipient('b1', { userId: 'u1', email: 'ada@example.com' });

    const floor = capturedLeaseFloor();
    expect(floor.getTime()).toBeLessThanOrEqual(before - CLAIM_LEASE_MS + 1_000);
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

  it('given a recipient whose user was erased, should drop the null id', async () => {
    selectRows = [{ userId: 'u1' }, { userId: null }];
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