import { describe, it, expect } from 'vitest';
import {
  READ_ONLY_SESSION_SQL,
  assertReadOnlySession,
  enforceReadOnlySession,
} from '../read-only-session';

describe('enforceReadOnlySession', () => {
  it('makes every connection the pool opens read-only at the server', () => {
    const queries: string[] = [];
    const listeners: Array<(client: { query: (sql: string) => void }) => void> = [];
    const pool = {
      on(event: string, listener: (client: { query: (sql: string) => void }) => void) {
        expect(event).toBe('connect');
        listeners.push(listener);
        return pool;
      },
    };

    enforceReadOnlySession(pool);
    // A pool opens connections lazily and reopens them after a drop; the guard
    // has to ride every connection, not just be run once at startup.
    for (const listener of listeners) {
      listener({ query: (sql) => queries.push(sql) });
      listener({ query: (sql) => queries.push(sql) });
    }

    expect(queries).toEqual([READ_ONLY_SESSION_SQL, READ_ONLY_SESSION_SQL]);
  });

  it('asks Postgres itself to refuse writes, rather than trusting the caller', () => {
    expect(READ_ONLY_SESSION_SQL).toBe('SET default_transaction_read_only = on');
  });
});

describe('assertReadOnlySession', () => {
  it('passes when Postgres reports the session read-only', () => {
    expect(() => assertReadOnlySession([{ default_transaction_read_only: 'on' }])).not.toThrow();
  });

  it('refuses to run when the setting did not take', () => {
    expect(() => assertReadOnlySession([{ default_transaction_read_only: 'off' }])).toThrow(
      /not read-only/,
    );
  });

  it('refuses to run when the check returned nothing at all', () => {
    expect(() => assertReadOnlySession([])).toThrow(/not read-only/);
  });
});
