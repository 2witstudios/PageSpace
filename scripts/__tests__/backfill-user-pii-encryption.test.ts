/**
 * Tests for the user-PII encryption backfill runner (GDPR #965).
 *
 * The pure planner is unit-tested in @pagespace/lib; here we verify the runner's
 * imperative loop: dry-run writes nothing, live mode encrypts only plaintext
 * rows, already-encrypted rows are skipped (idempotent), and pagination
 * terminates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({ db: { select: vi.fn(), update: vi.fn() } }));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id', email: 'email', name: 'name', emailBidx: 'emailBidx' },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: () => ({}), gt: () => ({}), asc: () => ({}) }));

import { backfill } from '../backfill-user-pii-encryption';
import { deriveIndexKey } from '@pagespace/lib/encryption/blind-index';
import { looksEncrypted } from '@pagespace/lib/encryption/field-crypto';

const MASTER = 'runner-test-master-key-at-least-32-characters!';
const indexKey = deriveIndexKey(MASTER);

beforeEach(() => {
  process.env.ENCRYPTION_KEY = MASTER;
});

/** Chainable select stub terminating on .limit(); returns successive batches. */
function selectReturning(batches: unknown[][]) {
  let call = 0;
  return vi.fn(() => {
    const rows = batches[call] ?? [];
    call += 1;
    const stub: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy']) stub[m] = () => stub;
    stub['limit'] = () => Promise.resolve(rows);
    return stub;
  });
}

function captureUpdate() {
  const sets: Array<Record<string, unknown>> = [];
  const update = vi.fn(() => ({
    set: (v: Record<string, unknown>) => {
      sets.push(v);
      return { where: () => Promise.resolve() };
    },
  }));
  return { update, sets };
}

describe('backfill-user-pii-encryption', () => {
  it('live mode: encrypts plaintext rows and writes email+name+emailBidx', async () => {
    const select = selectReturning([[{ id: 'u1', email: 'a@b.com', name: 'A', emailBidx: null }], []]);
    const { update, sets } = captureUpdate();
    const result = await backfill(false, { select, update } as never, indexKey);

    expect(result).toEqual({ encrypted: 1, skipped: 0 });
    expect(sets).toHaveLength(1);
    expect(looksEncrypted(sets[0].email as string)).toBe(true);
    expect(looksEncrypted(sets[0].name as string)).toBe(true);
    expect(sets[0].emailBidx).toMatch(/^[0-9a-f]{64}$/);
  });

  it('dry run: counts but writes nothing', async () => {
    const select = selectReturning([[{ id: 'u1', email: 'a@b.com', name: 'A', emailBidx: null }], []]);
    const { update, sets } = captureUpdate();
    const result = await backfill(true, { select, update } as never, indexKey);

    expect(result).toEqual({ encrypted: 1, skipped: 0 });
    expect(update).not.toHaveBeenCalled();
    expect(sets).toHaveLength(0);
  });

  it('idempotent: an already-encrypted row is skipped, not re-encrypted', async () => {
    const { update: enc } = captureUpdate();
    // First encrypt to obtain a realistic ciphertext row.
    const select1 = selectReturning([[{ id: 'u1', email: 'a@b.com', name: 'A', emailBidx: null }], []]);
    const cap = captureUpdate();
    await backfill(false, { select: select1, update: cap.update } as never, indexKey);
    const encryptedRow = { id: 'u1', email: cap.sets[0].email, name: cap.sets[0].name, emailBidx: cap.sets[0].emailBidx };

    const select2 = selectReturning([[encryptedRow], []]);
    const result = await backfill(false, { select: select2, update: enc } as never, indexKey);
    expect(result).toEqual({ encrypted: 0, skipped: 1 });
    expect(enc).not.toHaveBeenCalled();
  });
});
