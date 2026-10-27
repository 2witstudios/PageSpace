/**
 * Audience resolution decides who a mass email reaches, so what matters is the SQL it
 * actually builds — not that some function was called.
 *
 * These tests mock ONLY the database connection, capture the real `where` clause the
 * module hands the driver, and render it through drizzle's own dialect. The assertions
 * are therefore about the query Postgres would run, which is the thing that can quietly
 * stop excluding suspended accounts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const captured: { where?: SQL } = {};
let selectRows: unknown[] = [];

function makeChain() {
  const chain = {
    from: () => chain,
    where: (w: SQL) => {
      captured.where = w;
      return chain;
    },
    orderBy: () => chain,
    limit: () => chain,
    groupBy: () => chain,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(selectRows).then(resolve, reject),
  };
  return chain;
}

vi.mock('@pagespace/db/db', () => ({
  db: { select: vi.fn(() => makeChain()) },
}));

import { countAudience, loadOptedOutUserIds, loadRightsRestrictedUserIds, resolveAudience } from '../audience';

/** The SQL the captured clause compiles to, with its bound parameters. */
function compiled(): { sql: string; params: unknown[] } {
  if (!captured.where) throw new Error('no where clause was captured');
  const query = new PgDialect().sqlToQuery(captured.where);
  return { sql: query.sql, params: query.params };
}

beforeEach(() => {
  delete captured.where;
  selectRows = [];
});

describe('resolveAudience — standard exclusions', () => {
  it('should always exclude suspended accounts', async () => {
    await resolveAudience({});
    // Administratively cut off is administratively cut off; no definition lifts this.
    expect(compiled().sql).toContain('"suspendedAt" is null');
  });

  it('given no explicit opt-in, should exclude unverified addresses', async () => {
    await resolveAudience({});
    // An unverified address was never proven to belong to the account holder.
    expect(compiled().sql).toContain('"emailVerified" is not null');
  });

  it('given includeUnverified, should include them — the one liftable exclusion', async () => {
    await resolveAudience({ includeUnverified: true });
    const { sql } = compiled();
    expect(sql).not.toContain('"emailVerified" is not null');
    // ...but suspension is still enforced.
    expect(sql).toContain('"suspendedAt" is null');
  });

  it('given hand-picked userIds, should STILL apply the standard exclusions', async () => {
    // Picking a user by hand is not a way to mail a suspended or unverified account.
    await resolveAudience({ userIds: ['u1', 'u2'] });
    const { sql, params } = compiled();
    expect(sql).toContain('"suspendedAt" is null');
    expect(sql).toContain('"emailVerified" is not null');
    expect(params).toEqual(expect.arrayContaining(['u1', 'u2']));
  });
});

describe('resolveAudience — targeting filters', () => {
  it('given plan tiers, should filter to them', async () => {
    await resolveAudience({ planTiers: ['pro', 'business'] });
    const { sql, params } = compiled();
    expect(sql).toContain('"subscriptionTier" in');
    expect(params).toEqual(expect.arrayContaining(['pro', 'business']));
  });

  it('given an empty plan-tier array, should treat it as no filter rather than nobody', async () => {
    // An empty multi-select means the admin picked nothing, not that they want a
    // zero-recipient send.
    await resolveAudience({ planTiers: [] });
    expect(compiled().sql).not.toContain('"subscriptionTier"');
  });

  it('given a signup window, should bound createdAt at both ends', async () => {
    await resolveAudience({ signupAfter: '2026-01-01T00:00:00.000Z', signupBefore: '2026-06-01T00:00:00.000Z' });
    const { sql, params } = compiled();
    expect(sql).toContain('"createdAt" >=');
    expect(sql).toContain('"createdAt" <=');
    // Bound as ISO strings: the column's driver mapper serializes the Date on the way in.
    expect(params).toEqual(
      expect.arrayContaining(['2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z']),
    );
  });
});

describe('resolveAudience — keyset pagination', () => {
  it('given a cursor, should ask only for rows after it', async () => {
    await resolveAudience({}, { after: 'user_100' });
    const { sql, params } = compiled();
    expect(sql).toContain('"id" >');
    expect(params).toContain('user_100');
  });

  it('given a full page, should hand back a cursor pointing at the last row', async () => {
    selectRows = [
      { id: 'a', name: null, email: null },
      { id: 'b', name: null, email: null },
    ];
    const page = await resolveAudience({}, { limit: 2 });
    expect(page.nextCursor).toBe('b');
  });

  it('given a short page, should report the audience exhausted', async () => {
    selectRows = [{ id: 'a', name: null, email: null }];
    const page = await resolveAudience({}, { limit: 2 });
    expect(page.nextCursor).toBeNull();
  });

  it('should return rows still ENCRYPTED, leaving decryption to the caller', async () => {
    // PII widening past the send loop is the thing to avoid; audience.ts never decrypts.
    selectRows = [{ id: 'u1', name: 'ciphertext:name', email: 'ciphertext:email' }];
    const page = await resolveAudience({});
    expect(page.rows).toEqual([{ id: 'u1', name: 'ciphertext:name', email: 'ciphertext:email' }]);
  });
});

describe('countAudience', () => {
  it('should count with the same filters the send walks', async () => {
    selectRows = [{ value: 220 }];
    const total = await countAudience({ planTiers: ['pro'] });

    expect(total).toBe(220);
    const { sql } = compiled();
    expect(sql).toContain('"suspendedAt" is null');
    expect(sql).toContain('"subscriptionTier" in');
  });

  it('given no matching rows, should report zero rather than undefined', async () => {
    selectRows = [];
    expect(await countAudience({})).toBe(0);
  });
});

describe('loadOptedOutUserIds', () => {
  it('should select only users who turned this channel OFF', async () => {
    selectRows = [{ userId: 'u1' }, { userId: 'u2' }];
    const optedOut = await loadOptedOutUserIds('PRODUCT_UPDATE');

    expect(optedOut).toEqual(new Set(['u1', 'u2']));
    const { params } = compiled();
    expect(params).toEqual(expect.arrayContaining(['PRODUCT_UPDATE', false]));
  });
});

describe('loadRightsRestrictedUserIds', () => {
  it('should exclude erasures that have not executed yet, not just completed ones', async () => {
    // The Resend suppression audience only holds erasures that already RAN. A queued or
    // blocked erasure leaves a normal-looking user row, and mailing that person is the
    // exact harm the request was made to prevent.
    selectRows = [];
    await loadRightsRestrictedUserIds();

    const { params } = compiled();
    expect(params).toEqual(
      expect.arrayContaining(['erasure', 'pending', 'queued', 'in_progress', 'blocked', 'failed']),
    );
  });

  it('should exclude objections and restrictions unless cancelled', async () => {
    // Honouring an objection to direct marketing is what makes it COMPLETED, so a
    // completed objection must still exclude. Only a cancellation releases us.
    selectRows = [];
    await loadRightsRestrictedUserIds();

    const { sql, params } = compiled();
    expect(params).toEqual(expect.arrayContaining(['objection', 'restriction', 'cancelled']));
    expect(sql).toContain('<>');
  });

  it('given rows whose user was already erased, should drop the null ids', async () => {
    selectRows = [{ userId: 'u1' }, { userId: null }];
    expect(await loadRightsRestrictedUserIds()).toEqual(new Set(['u1']));
  });
});