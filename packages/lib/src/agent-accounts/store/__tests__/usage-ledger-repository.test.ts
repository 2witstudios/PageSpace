import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import type { AccountId, TenantId } from '@pagespace/db/schema/agent-accounts';
import { createUsageLedgerRepository } from '../usage-ledger-repository';
import type { SecretRef } from '../store-adapter';

const ref: SecretRef = { tenantId: 't-1' as TenantId, accountId: 'a-1' as AccountId, kind: 'api_key' };

/** A pooled client that, like pg's, is an EventEmitter; `failOn` makes one statement reject. */
function fakePool(failOn?: string) {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (text: string) => {
      if (failOn && text.startsWith(failOn)) throw new Error(`${failOn} failed`);
      return { rows: [{ uses: 0, bytes: 0, concurrent: 0 }] };
    }),
    release: vi.fn(),
  });
  const pool = { query: vi.fn(), connect: vi.fn(async () => client as unknown as PoolClient) } as unknown as Pick<Pool, 'query' | 'connect'>;
  return { pool, client };
}

const reserveInput = { ref, grantId: 'g-1', bytes: 0, now: Date.now(), admits: () => true };

describe('UsageLedger.reserve — the checked-out client\'s error listener', () => {
  it('given a successful reserve, should leave no listener behind and pool the connection', async () => {
    // pg-pool re-attaches only its own idle listener on release; one leaked listener per reserve
    // would pile up on a long-lived pooled client (MaxListenersExceededWarning after ten).
    const { pool, client } = fakePool();

    await expect(createUsageLedgerRepository({ pool }).reserve(reserveInput)).resolves.toBe(true);

    expect(client.listenerCount('error')).toBe(0);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it('given a SQL error whose ROLLBACK succeeds, should leave no listener behind and still pool the connection', async () => {
    const { pool, client } = fakePool('INSERT');

    await expect(createUsageLedgerRepository({ pool }).reserve(reserveInput)).resolves.toBe(false);

    expect(client.listenerCount('error')).toBe(0);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it('given the connection emits error mid-transaction, should absorb it, refuse, and destroy the connection', async () => {
    const { pool, client } = fakePool();
    const dropped = new Error('Connection terminated unexpectedly');
    client.query.mockImplementation(async (text: string) => {
      if (text.startsWith('SELECT pg_advisory_xact_lock')) {
        client.emit('error', dropped);
        throw dropped;
      }
      if (text === 'ROLLBACK') throw new Error('Client was closed and is not queryable');
      return { rows: [{ uses: 0, bytes: 0, concurrent: 0 }] };
    });

    await expect(createUsageLedgerRepository({ pool }).reserve(reserveInput)).resolves.toBe(false);

    expect(client.listenerCount('error')).toBe(0);
    expect(client.release).toHaveBeenCalledWith(dropped);
  });
});
