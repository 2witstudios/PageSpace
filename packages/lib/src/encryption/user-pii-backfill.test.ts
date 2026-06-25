/**
 * Pure planner for the user-PII encryption backfill (GDPR #965, Phase 2).
 *
 * Decides, per existing row, what update to apply. Idempotent: rows whose email
 * is already ciphertext are skipped so re-runs converge and partial runs resume.
 * The blind index is always derived from the PLAINTEXT email, so the planner
 * acts only while the email is still plaintext (atomic ct+name+bidx write).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { deriveIndexKey, emailBlindIndex } from './blind-index';
import { looksEncrypted } from './field-crypto';
import { planUserPiiBackfill } from './user-pii-backfill';

const MASTER = 'backfill-test-master-key-at-least-32-chars!!';
const indexKey = deriveIndexKey(MASTER);

beforeAll(() => {
  process.env.ENCRYPTION_KEY = MASTER;
});

describe('planUserPiiBackfill', () => {
  it('given a plaintext row, should plan encrypted email+name and the correct blind index', async () => {
    const update = await planUserPiiBackfill(
      { id: 'u1', email: 'Plain@Example.com', name: 'Plain User', emailBidx: null },
      indexKey,
    );
    expect(update).not.toBeNull();
    expect(update!.id).toBe('u1');
    expect(looksEncrypted(update!.email)).toBe(true);
    expect(looksEncrypted(update!.name)).toBe(true);
    // Blind index derived from the PLAINTEXT (normalized) email, not ciphertext.
    expect(update!.emailBidx).toBe(emailBlindIndex('plain@example.com', indexKey));
  });

  it('given an already-encrypted row with a blind index, should skip (idempotent)', async () => {
    const done = await planUserPiiBackfill(
      { id: 'u1', email: 'Plain@Example.com', name: 'Plain User', emailBidx: null },
      indexKey,
    );
    const rerun = await planUserPiiBackfill(
      { id: 'u1', email: done!.email, name: done!.name, emailBidx: done!.emailBidx },
      indexKey,
    );
    expect(rerun).toBeNull();
  });

  it('given an empty/falsy name, should still encrypt email and produce a blind index', async () => {
    const update = await planUserPiiBackfill(
      { id: 'u2', email: 'x@y.com', name: '', emailBidx: null },
      indexKey,
    );
    expect(update).not.toBeNull();
    expect(looksEncrypted(update!.email)).toBe(true);
    expect(update!.emailBidx).toBe(emailBlindIndex('x@y.com', indexKey));
  });
});
