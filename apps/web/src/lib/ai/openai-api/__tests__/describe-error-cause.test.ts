import { describe, test } from 'vitest';
import { assert } from './riteway';
import { describeErrorCause } from '../describe-error-cause';

describe('describeErrorCause', () => {
  test('lifts the Postgres diagnostics out of a Drizzle-wrapped query error', () => {
    const cause = Object.assign(new Error('insert or update on table "messages" violates foreign key constraint'), {
      code: '23503',
      constraint: 'messages_conversationId_conversations_id_fk',
      detail: 'Key (conversationId)=(k7otmhzstwtj8v47d9gjw1cq) is not present in table "conversations".',
      table: 'messages',
    });
    const wrapped = new Error('Failed query: insert into "messages" ...', { cause });

    assert({
      given: 'a Failed query error whose cause carries the FK violation',
      should: 'return the sqlstate, constraint, detail, table and cause message',
      actual: describeErrorCause(wrapped),
      expected: {
        causeMessage: 'insert or update on table "messages" violates foreign key constraint',
        causeCode: '23503',
        causeConstraint: 'messages_conversationId_conversations_id_fk',
        causeDetail: 'Key (conversationId)=(k7otmhzstwtj8v47d9gjw1cq) is not present in table "conversations".',
        causeTable: 'messages',
      },
    });
  });

  test('reports only the fields the cause actually carries', () => {
    const wrapped = new Error('Failed query', { cause: Object.assign(new Error('deadlock detected'), { code: '40P01' }) });

    assert({
      given: 'a cause with a message and a code but no constraint/detail/table',
      should: 'omit the absent fields rather than emitting empty ones',
      actual: describeErrorCause(wrapped),
      expected: { causeMessage: 'deadlock detected', causeCode: '40P01' },
    });
  });

  test('returns undefined when there is no cause worth logging', () => {
    assert({
      given: 'errors with no cause, a non-object cause, and a cause with no string fields',
      should: 'return undefined for each so callers can spread unconditionally',
      actual: [
        describeErrorCause(new Error('plain')),
        describeErrorCause(new Error('wrapped', { cause: 'a string cause' })),
        describeErrorCause(new Error('wrapped', { cause: { code: 23503 } })),
        describeErrorCause(undefined),
        describeErrorCause('not an error'),
      ],
      expected: [undefined, undefined, undefined, undefined, undefined],
    });
  });
});
