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

const recipientInserts = () => insertCalls.filter((c) => c.table === broadcastRecipients);
const logInserts = () => insertCalls.filter((c) => c.table === emailNotificationLog);

beforeEach(() => {
  insertCalls.length = 0;
  insertFailures.clear();
  selectRows = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
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