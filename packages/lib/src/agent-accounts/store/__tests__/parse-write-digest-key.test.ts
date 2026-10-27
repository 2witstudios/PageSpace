/**
 * G2 ruling 4 — the plane-held HMAC key for the pending-write digest. Read from
 * the PLANE process's own environment (never the main DB, never the web
 * process). An unset or short key is a refusal, never a fallback: a digest
 * under an empty or guessable key is the dictionary oracle ruling 4 removes.
 */
import { describe, expect, it } from 'vitest';
import { parseWriteDigestKey } from '../parse-write-digest-key';

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

describe('parseWriteDigestKey (G2 ruling 4)', () => {
  it('given a base64 key of at least 32 bytes, should return the key bytes', () => {
    const raw = new Uint8Array(32).fill(5);
    const actual = parseWriteDigestKey({ raw: b64(raw) });
    const expected = { ok: true, key: raw };
    expect(actual).toEqual(expected);
  });

  it('given an unset or blank value, should refuse unset', () => {
    const actual = [parseWriteDigestKey({ raw: undefined }), parseWriteDigestKey({ raw: '   ' })];
    const expected = [{ ok: false, reason: 'unset' }, { ok: false, reason: 'unset' }];
    expect(actual).toEqual(expected);
  });

  it('given a key shorter than 32 bytes or a value that is not base64, should refuse malformed', () => {
    const actual = [parseWriteDigestKey({ raw: b64(new Uint8Array(31).fill(1)) }), parseWriteDigestKey({ raw: 'not base64 at all!' })];
    const expected = [{ ok: false, reason: 'malformed' }, { ok: false, reason: 'malformed' }];
    expect(actual).toEqual(expected);
  });
});
