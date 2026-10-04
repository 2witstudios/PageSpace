import { describe, it, expect } from 'vitest';
import { errorCauseChain, errorLogFields, formatCauseChain } from '../error-cause';

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
