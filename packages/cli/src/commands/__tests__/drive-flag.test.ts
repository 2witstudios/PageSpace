import { describe, expect, it } from 'vitest';
import { extractDriveFlag } from '../drive-flag.js';

describe('extractDriveFlag (pure)', () => {
  it('returns driveId undefined and rest unchanged when --drive is absent', () => {
    expect(extractDriveFlag(['pg_parent'])).toEqual({ ok: true, driveId: undefined, rest: ['pg_parent'] });
  });

  it('extracts --drive and its value, leaving the rest in order', () => {
    expect(extractDriveFlag(['pg_parent', '--drive', 'drv_1'])).toEqual({ ok: true, driveId: 'drv_1', rest: ['pg_parent'] });
  });

  it('extracts --drive when it leads, leaving trailing positionals intact', () => {
    expect(extractDriveFlag(['--drive', 'drv_1', 'RFC-1', 'DOCUMENT'])).toEqual({
      ok: true,
      driveId: 'drv_1',
      rest: ['RFC-1', 'DOCUMENT'],
    });
  });

  it('extracts --drive from the middle of other positionals', () => {
    expect(extractDriveFlag(['RFC-1', '--drive', 'drv_1', 'DOCUMENT'])).toEqual({
      ok: true,
      driveId: 'drv_1',
      rest: ['RFC-1', 'DOCUMENT'],
    });
  });

  it('fails closed with a usage message when --drive has no value', () => {
    expect(extractDriveFlag(['--drive'])).toEqual({ ok: false, message: 'Flag --drive requires a value.' });
  });

  it('is a pure function: identical input produces a deep-equal result', () => {
    const args = ['pg_parent', '--drive', 'drv_1'];
    expect(extractDriveFlag(args)).toEqual(extractDriveFlag(args));
  });
});
