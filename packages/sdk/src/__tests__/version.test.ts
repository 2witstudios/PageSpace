/**
 * Pure compatibility functions per ADR 0001 D6/D7 (docs/adr/0001-sdk-api-versioning.md).
 */
import { describe, expect, it } from 'vitest';
import { checkServerCompatibility, compareApiVersions, parseApiVersion } from '../version.js';

describe('parseApiVersion', () => {
  it('parses a strict MAJOR.MINOR.PATCH string', () => {
    expect(parseApiVersion('1.3.0')).toEqual({ major: 1, minor: 3, patch: 0 });
  });

  it.each(['latest', '', '1.0', 'v1.0.0', '1.0.0-beta', '1.0.0.0', 'abc'])(
    'returns null for malformed input %j',
    (raw) => {
      expect(parseApiVersion(raw)).toBeNull();
    },
  );
});

describe('compareApiVersions', () => {
  it('orders by major first', () => {
    expect(compareApiVersions({ major: 1, minor: 9, patch: 9 }, { major: 2, minor: 0, patch: 0 })).toBe(-1);
    expect(compareApiVersions({ major: 2, minor: 0, patch: 0 }, { major: 1, minor: 9, patch: 9 })).toBe(1);
  });

  it('orders by minor when major matches', () => {
    expect(compareApiVersions({ major: 1, minor: 2, patch: 9 }, { major: 1, minor: 3, patch: 0 })).toBe(-1);
    expect(compareApiVersions({ major: 1, minor: 3, patch: 0 }, { major: 1, minor: 2, patch: 9 })).toBe(1);
  });

  it('orders by patch when major and minor match', () => {
    expect(compareApiVersions({ major: 1, minor: 3, patch: 0 }, { major: 1, minor: 3, patch: 1 })).toBe(-1);
    expect(compareApiVersions({ major: 1, minor: 3, patch: 1 }, { major: 1, minor: 3, patch: 0 })).toBe(1);
  });

  it('returns 0 for equal versions', () => {
    expect(compareApiVersions({ major: 1, minor: 3, patch: 0 }, { major: 1, minor: 3, patch: 0 })).toBe(0);
  });
});

describe('checkServerCompatibility — ADR 0001 D7 assertions', () => {
  it('D7.1 — null serverVersion is missing-header, never ok', () => {
    expect(checkServerCompatibility(null, '1.3.0')).toEqual({
      ok: false,
      reason: 'missing-header',
      serverVersion: null,
      sdkMinVersion: '1.3.0',
    });
  });

  it.each(['latest', '', '1.0', 'v1.0.0', '1.0.0-beta'])('D7.2 — malformed-version for %j', (raw) => {
    expect(checkServerCompatibility(raw, '1.3.0')).toEqual({
      ok: false,
      reason: 'malformed-version',
      serverVersion: raw,
      sdkMinVersion: '1.3.0',
    });
  });

  it('D7.3 — a newer server major is major-mismatch, not accepted', () => {
    expect(checkServerCompatibility('2.0.0', '1.3.0')).toEqual({
      ok: false,
      reason: 'major-mismatch',
      serverVersion: '2.0.0',
      sdkMinVersion: '1.3.0',
    });
  });

  it('D7.4 — an older server within the same major is server-too-old', () => {
    expect(checkServerCompatibility('1.2.9', '1.3.0')).toEqual({
      ok: false,
      reason: 'server-too-old',
      serverVersion: '1.2.9',
      sdkMinVersion: '1.3.0',
    });
  });

  it('D7.5 — server at or above the minimum, same major, is ok', () => {
    expect(checkServerCompatibility('1.3.0', '1.3.0')).toEqual({ ok: true, serverVersion: '1.3.0' });
    expect(checkServerCompatibility('1.9.4', '1.3.0')).toEqual({ ok: true, serverVersion: '1.9.4' });
  });

  it('D7.6 — referentially transparent: same inputs, same output, every time', () => {
    const first = checkServerCompatibility('1.3.0', '1.3.0');
    const second = checkServerCompatibility('1.3.0', '1.3.0');
    expect(first).toEqual(second);
  });
});
