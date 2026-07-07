import { describe, expect, it } from 'vitest';
import { parseTokensCreateArgs, parseTokensRevokeArgs } from '../args.js';

describe('parseTokensCreateArgs', () => {
  it('parses no flags as no drives and no --save-as-profile', () => {
    const result = parseTokensCreateArgs([]);
    expect(result).toEqual({ ok: true, args: { drives: [], saveAsProfile: undefined } });
  });

  it('parses a single --drive with no --role as inherit (role null)', () => {
    const result = parseTokensCreateArgs(['--drive', 'drv1']);
    expect(result).toEqual({ ok: true, args: { drives: [{ id: 'drv1', role: null }], saveAsProfile: undefined } });
  });

  it('maps --role member to MEMBER (case-insensitive)', () => {
    const result = parseTokensCreateArgs(['--drive', 'drv1', '--role', 'Member']);
    expect(result).toEqual({ ok: true, args: { drives: [{ id: 'drv1', role: 'MEMBER' }], saveAsProfile: undefined } });
  });

  it('maps --role admin to ADMIN (case-insensitive)', () => {
    const result = parseTokensCreateArgs(['--drive', 'drv1', '--role', 'ADMIN']);
    expect(result).toEqual({ ok: true, args: { drives: [{ id: 'drv1', role: 'ADMIN' }], saveAsProfile: undefined } });
  });

  it('maps any other --role value to a customRoleId, role null', () => {
    const result = parseTokensCreateArgs(['--drive', 'drv1', '--role', 'role-xyz']);
    expect(result).toEqual({
      ok: true,
      args: { drives: [{ id: 'drv1', role: null, customRoleId: 'role-xyz' }], saveAsProfile: undefined },
    });
  });

  it('parses multiple --drive entries with independent roles', () => {
    const result = parseTokensCreateArgs([
      '--drive', 'drv1', '--role', 'member',
      '--drive', 'drv2', '--role', 'admin',
      '--drive', 'drv3',
    ]);
    expect(result).toEqual({
      ok: true,
      args: {
        drives: [
          { id: 'drv1', role: 'MEMBER' },
          { id: 'drv2', role: 'ADMIN' },
          { id: 'drv3', role: null },
        ],
        saveAsProfile: undefined,
      },
    });
  });

  it('parses --save-as-profile', () => {
    const result = parseTokensCreateArgs(['--drive', 'drv1', '--save-as-profile', 'ci-bot']);
    expect(result).toEqual({
      ok: true,
      args: { drives: [{ id: 'drv1', role: null }], saveAsProfile: 'ci-bot' },
    });
  });

  it('rejects --save-as-profile with a missing value', () => {
    const result = parseTokensCreateArgs(['--save-as-profile']);
    expect(result).toEqual({ ok: false, message: 'Flag --save-as-profile requires a value.' });
  });

  it('rejects a second --save-as-profile', () => {
    const result = parseTokensCreateArgs(['--save-as-profile', 'a', '--save-as-profile', 'b']);
    expect(result).toEqual({ ok: false, message: 'Flag --save-as-profile was given more than once.' });
  });

  it('rejects --role with no preceding --drive', () => {
    const result = parseTokensCreateArgs(['--role', 'member']);
    expect(result).toEqual({ ok: false, message: '--role must follow a --drive flag.' });
  });

  it('rejects a second --role for the same --drive', () => {
    const result = parseTokensCreateArgs(['--drive', 'drv1', '--role', 'member', '--role', 'admin']);
    expect(result.ok).toBe(false);
  });

  it('rejects --drive with a missing value', () => {
    const result = parseTokensCreateArgs(['--drive']);
    expect(result).toEqual({ ok: false, message: 'Flag --drive requires a value.' });
  });

  it('rejects an unknown flag', () => {
    const result = parseTokensCreateArgs(['--bogus']);
    expect(result).toEqual({ ok: false, message: 'Unknown flag: --bogus' });
  });

  it('is a pure function: identical input produces a deep-equal result', () => {
    const rest = ['--drive', 'drv1', '--role', 'member'];
    expect(parseTokensCreateArgs(rest)).toEqual(parseTokensCreateArgs(rest));
  });
});

describe('parseTokensRevokeArgs', () => {
  it('parses a bare token id', () => {
    const result = parseTokensRevokeArgs(['tok_123']);
    expect(result).toEqual({ ok: true, args: { tokenId: 'tok_123' } });
  });

  it('rejects a missing token id', () => {
    const result = parseTokensRevokeArgs([]);
    expect(result.ok).toBe(false);
  });

  it('rejects an unexpected extra argument', () => {
    const result = parseTokensRevokeArgs(['tok_123', 'extra']);
    expect(result).toEqual({ ok: false, message: 'Unexpected extra argument: extra' });
  });
});
