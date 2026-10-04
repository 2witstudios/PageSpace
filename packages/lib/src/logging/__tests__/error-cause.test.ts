import { describe, it, expect } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { errorCauseChain, errorLogFields, formatCauseChain, VALUE_ECHO_WITHHELD } from '../error-cause';

/** `new Error(message, { cause })` without the ES2022 lib this package does not target. */
const withCause = (message: string, cause: unknown): Error => Object.assign(new Error(message), { cause });


/** What Drizzle throws: its own wrapper, with the driver's error (and its SQLSTATE) on .cause. */
function drizzleWrapped(): Error {
  const pg = Object.assign(new Error('sorry, too many clients already'), { name: 'error', code: '53300', severity: 'FATAL' });
  return withCause('Failed query: select "id" from "wallets"', pg);
}

describe('errorCauseChain', () => {
  it('pk862snl: walks .cause and keeps the driver error\'s SQLSTATE, so a Postgres FATAL is not a bare "Failed query"', () => {
    expect(errorCauseChain(drizzleWrapped())).toEqual([{ name: 'error', message: 'sorry, too many clients already', code: '53300' }]);
  });

  it('follows a nested chain in order and stops at a cycle or the depth limit', () => {
    const inner = new Error('inner');
    const middle = withCause('middle', inner);
    const outer = withCause('outer', middle);
    expect(errorCauseChain(outer).map((l) => l.message)).toEqual(['middle', 'inner']);

    const a = new Error('a');
    const b = withCause('b', a);
    (a as { cause?: unknown }).cause = b;
    expect(errorCauseChain(b).map((l) => l.message)).toEqual(['a']);

    let deep = new Error('0');
    for (let i = 1; i <= 10; i += 1) deep = withCause(String(i), deep);
    expect(errorCauseChain(deep)).toHaveLength(5);
  });

  it('records a non-Error cause as its string, and an error with no cause as no chain', () => {
    expect(errorCauseChain(withCause('x', 'socket hang up'))).toEqual([{ name: 'NonError', message: 'socket hang up' }]);
    expect(errorCauseChain(new Error('plain'))).toEqual([]);
    expect(errorCauseChain('not an error')).toEqual([]);
  });

  it('formats the chain as Caused by lines a stack can carry', () => {
    expect(formatCauseChain(errorCauseChain(drizzleWrapped()))).toBe('Caused by: error: sorry, too many clients already [53300]');
    expect(formatCauseChain([])).toBe('');
  });
});

describe('errorLogFields', () => {
  it('pk862snl: a catch logging at warn or debug keeps its message AND the driver error under it', () => {
    expect(errorLogFields(drizzleWrapped())).toEqual({
      error: 'Failed query: select "id" from "wallets"',
      cause: [{ name: 'error', message: 'sorry, too many clients already', code: '53300' }],
    });
  });

  it('is just the message for an error with no cause, and a string for a non-Error', () => {
    expect(errorLogFields(new Error('plain'))).toEqual({ error: 'plain' });
    expect(errorLogFields('boom')).toEqual({ error: 'boom' });
  });
});

describe('bound query parameters never reach a log line (review P3-4)', () => {
  const pg = Object.assign(new Error('relation "wallets_x" does not exist'), { code: '42P01' });
  const secretQuery = () => new DrizzleQueryError('select "id" from "wallets_x" where "token" = $1 and "note" = $2', ['sk_live_SECRET', 'line one\nsk_live_SECOND'], pg);

  it('keeps the SQL shape and the cause chain, and drops every bound value — even one spanning lines', () => {
    const fields = errorLogFields(secretQuery());
    expect(fields.error).toBe('Failed query: select "id" from "wallets_x" where "token" = $1 and "note" = $2\nparams: [redacted]');
    expect(fields.cause).toEqual([{ name: 'Error', message: 'relation "wallets_x" does not exist', code: '42P01' }]);
    expect(JSON.stringify(fields)).not.toContain('sk_live');
  });

  it('a Drizzle error nested in a chain is redacted too', () => {
    const outer = withCause('settle failed', secretQuery());
    expect(JSON.stringify(errorCauseChain(outer))).not.toContain('sk_live');
  });
});

describe('a value-echoing SQLSTATE class 22 message never reaches a log line (review #2760 P3-1)', () => {
  // What Postgres says for `select $1::int` with a secret bound: the message quotes the value.
  const castError = () => Object.assign(new Error('invalid input syntax for type integer: "sk_live_SECRET2"'), { name: 'error', code: '22P02' });

  it('withholds a class-22 cause\'s message and keeps its name and SQLSTATE', () => {
    const secret = new DrizzleQueryError('select $1::int', ['sk_live_SECRET2'], castError());
    const fields = errorLogFields(secret);
    expect(fields.cause).toEqual([{ name: 'error', message: VALUE_ECHO_WITHHELD, code: '22P02' }]);
    expect(formatCauseChain(errorCauseChain(secret))).toBe(`Caused by: error: ${VALUE_ECHO_WITHHELD} [22P02]`);
    expect(JSON.stringify(fields)).not.toContain('sk_live');
  });

  it('withholds a class-22 error\'s own message when it is logged directly', () => {
    expect(errorLogFields(castError()).error).toBe(VALUE_ECHO_WITHHELD);
  });

  it('leaves every other class alone — a 53300 is still read as an outage', () => {
    const pg = Object.assign(new Error('sorry, too many clients already'), { code: '53300' });
    expect(errorLogFields(withCause('Failed query: x', pg)).cause).toEqual([{ name: 'Error', message: 'sorry, too many clients already', code: '53300' }]);
  });
});
