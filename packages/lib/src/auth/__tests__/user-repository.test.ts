/**
 * Encryption-aware user repository edge (GDPR #965 live cutover).
 *
 * Proves the SAFETY INVARIANT of the cutover:
 *  - new/updated rows always get the deterministic `emailBidx` (so lookups work
 *    even before the value is encrypted), and ciphertext only when the flag is on;
 *  - a lookup resolves a ciphertext row by `emailBidx` AND a legacy plaintext row
 *    by the raw-email fallback (dual lookup);
 *  - rows decrypt back to plaintext at the edge regardless of mixed state.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { deriveIndexKey, emailBlindIndex } from '../../encryption/blind-index';
import { looksEncrypted, decryptField } from '../../encryption/field-crypto';
import {
  getUserIndexKey,
  isPiiCiphertextWriteEnabled,
  userEmailLookupTargets,
  encryptUserWriteFields,
  decryptUserRow,
  decryptUserRows,
  userInListLookupTargets,
} from '../user-repository';

const MASTER = 'user-repository-test-master-key-32-chars!!';
const indexKey = deriveIndexKey(MASTER);

const ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ENV };
});

describe('getUserIndexKey (env edge)', () => {
  it('given ENCRYPTION_KEY >= 32 chars, derives a deterministic key', () => {
    process.env.ENCRYPTION_KEY = MASTER;
    const k = getUserIndexKey();
    expect(k).not.toBeNull();
    expect(k!.equals(indexKey)).toBe(true);
  });

  it('given no/short ENCRYPTION_KEY, returns null (today behaviour)', () => {
    delete process.env.ENCRYPTION_KEY;
    expect(getUserIndexKey()).toBeNull();
    process.env.ENCRYPTION_KEY = 'too-short';
    expect(getUserIndexKey()).toBeNull();
  });
});

describe('isPiiCiphertextWriteEnabled (flag truth table)', () => {
  it('requires BOTH a key and PII_ENCRYPTION_ENABLED=true', () => {
    process.env.ENCRYPTION_KEY = MASTER;
    process.env.PII_ENCRYPTION_ENABLED = 'true';
    expect(isPiiCiphertextWriteEnabled()).toBe(true);
  });
  it('off when flag unset even with a key (staged: bidx only)', () => {
    process.env.ENCRYPTION_KEY = MASTER;
    delete process.env.PII_ENCRYPTION_ENABLED;
    expect(isPiiCiphertextWriteEnabled()).toBe(false);
  });
  it('off when no key even with flag set', () => {
    delete process.env.ENCRYPTION_KEY;
    process.env.PII_ENCRYPTION_ENABLED = 'true';
    expect(isPiiCiphertextWriteEnabled()).toBe(false);
  });
});

describe('encryptUserWriteFields — write path staging', () => {
  it('key + ciphertext flag: encrypts email & name and emits bidx', async () => {
    const out = await encryptUserWriteFields(
      { email: 'Alice@Example.com', name: 'Alice', role: 'user' },
      indexKey,
      true,
    );
    expect(looksEncrypted(out.email)).toBe(true);
    expect(looksEncrypted(out.name)).toBe(true);
    expect(out.emailBidx).toBe(emailBlindIndex('alice@example.com', indexKey));
    // unrelated fields pass through untouched
    expect(out.role).toBe('user');
  });

  it('key but flag OFF (staged): plaintext values BUT bidx populated', async () => {
    const out = await encryptUserWriteFields(
      { email: 'Bob@Example.com', name: 'Bob' },
      indexKey,
      false,
    );
    expect(out.email).toBe('Bob@Example.com');
    expect(out.name).toBe('Bob');
    expect(out.emailBidx).toBe(emailBlindIndex('bob@example.com', indexKey));
  });

  it('no key: byte-identical to input, no bidx (today behaviour)', async () => {
    const out = await encryptUserWriteFields(
      { email: 'c@x.com', name: 'C' },
      null,
      false,
    );
    expect(out).toEqual({ email: 'c@x.com', name: 'C' });
    expect('emailBidx' in out).toBe(false);
  });

  it('name-only update (no email): does not invent a bidx', async () => {
    const out = await encryptUserWriteFields({ name: 'Renamed' }, indexKey, true);
    expect(looksEncrypted(out.name)).toBe(true);
    expect('emailBidx' in out).toBe(false);
  });

  it('email-only update: encrypts email + recomputes bidx', async () => {
    const out = await encryptUserWriteFields({ email: 'new@x.com' }, indexKey, true);
    expect(looksEncrypted(out.email)).toBe(true);
    expect(out.emailBidx).toBe(emailBlindIndex('new@x.com', indexKey));
  });
});

describe('userEmailLookupTargets — dual-lookup parity (the hard gate)', () => {
  it('with a key: bidx target equals the bidx the write path stored', async () => {
    const written = await encryptUserWriteFields(
      { email: 'Carol@Example.com', name: 'Carol' },
      indexKey,
      true,
    );
    // a later login normalizes case/whitespace
    const targets = userEmailLookupTargets('  carol@example.com ', indexKey);
    expect(targets.emailBidx).toBe(written.emailBidx); // ciphertext row found by bidx
    expect(targets.email).toBe('  carol@example.com '); // raw fallback preserved verbatim
  });

  it('without a key: only the raw-email fallback (legacy plaintext rows)', () => {
    const targets = userEmailLookupTargets('legacy@x.com', null);
    expect(targets.emailBidx).toBeNull();
    expect(targets.email).toBe('legacy@x.com');
  });

  it('different emails do not collide on the bidx', () => {
    const a = userEmailLookupTargets('d1@x.com', indexKey);
    const b = userEmailLookupTargets('d2@x.com', indexKey);
    expect(a.emailBidx).not.toBe(b.emailBidx);
  });
});

describe('userInListLookupTargets — IN-list dual lookup (calendar sync)', () => {
  it('with a key: blind-index list parity + lowercased raw fallback list', async () => {
    const written = await encryptUserWriteFields(
      { email: 'List@Example.com', name: 'L' },
      indexKey,
      true,
    );
    const t = userInListLookupTargets(['List@Example.com', 'other@x.com'], indexKey);
    expect(t.emailBidxList).toContain(written.emailBidx);
    expect(t.emailListLower).toEqual(['list@example.com', 'other@x.com']);
  });

  it('without a key: only the lowercased raw fallback list', () => {
    const t = userInListLookupTargets(['A@B.com'], null);
    expect(t.emailBidxList).toBeNull();
    expect(t.emailListLower).toEqual(['a@b.com']);
  });
});

describe('decryptUserRow / decryptUserRows — read projection', () => {
  it('decrypts a ciphertext row back to plaintext', async () => {
    process.env.ENCRYPTION_KEY = MASTER;
    const enc = await encryptUserWriteFields({ email: 'eve@x.com', name: 'Eve' }, indexKey, true);
    const dec = await decryptUserRow({ id: '1', email: enc.email, name: enc.name });
    expect(dec).toEqual({ id: '1', email: 'eve@x.com', name: 'Eve' });
  });

  it('passes a legacy plaintext row through unchanged (mixed state safe)', async () => {
    const dec = await decryptUserRow({ id: '2', email: 'legacy@x.com', name: 'Legacy' });
    expect(dec).toEqual({ id: '2', email: 'legacy@x.com', name: 'Legacy' });
  });

  it('is null-safe and tolerates missing fields', async () => {
    expect(await decryptUserRow(null)).toBeNull();
    expect(await decryptUserRow(undefined)).toBeUndefined();
    const partial = await decryptUserRow({ id: '3', name: 'OnlyName' });
    expect(partial).toEqual({ id: '3', name: 'OnlyName' });
  });

  it('decryptUserRows maps an array (null entries preserved)', async () => {
    process.env.ENCRYPTION_KEY = MASTER;
    const enc = await encryptUserWriteFields({ email: 'rows@x.com', name: 'Rows' }, indexKey, true);
    const out = await decryptUserRows([
      { id: 'a', email: enc.email, name: enc.name },
      { id: 'b', email: 'plain@x.com', name: 'Plain' },
    ]);
    expect(out[0]).toEqual({ id: 'a', email: 'rows@x.com', name: 'Rows' });
    expect(out[1]).toEqual({ id: 'b', email: 'plain@x.com', name: 'Plain' });
    // sanity: decryptField round-trips ciphertext
    expect(await decryptField(enc.email)).toBe('rows@x.com');
  });
});
