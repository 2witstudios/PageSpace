import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { READ_ONLY_SESSION_SQL, assertReadOnlySession, enforceReadOnlySession } from '../read-only-session';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '../../../../..');

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

/**
 * The census runs against production with the production credential. "It only
 * reads" has to be checkable without reading the whole script, so it is a test:
 * no census source may contain a write.
 */
describe('the census is read-only by construction', () => {
  const sources = [
    'scripts/collab-content-census.ts',
    'src/lib/editor/census/constructs.ts',
    'src/lib/editor/census/round-trip.ts',
    'src/lib/editor/census/markdown.ts',
    'src/lib/editor/census/report.ts',
    'src/lib/editor/census/read-only-session.ts',
  ];

  // Comments are stripped first: the script's own header explains that it never
  // runs an INSERT, and a scanner that cannot tell code from prose would either
  // fail on that sentence or force the sentence out of the file.
  const codeOf = (relative: string) =>
    readFileSync(path.join(appRoot, relative), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const writes = [
    /\.insert\s*\(/,
    /\.update\s*\(/,
    /\.delete\s*\(/,
    /\btransaction\s*\(/,
    /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT)\b/i,
  ];

  it.each(sources)('%s contains no write', (relative) => {
    const code = codeOf(relative);
    for (const write of writes) {
      expect(code).not.toMatch(write);
    }
  });

  it('strips comments before scanning, but not code that follows one', () => {
    expect(codeOf('scripts/collab-content-census.ts')).toContain('getMigrationDb');
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
