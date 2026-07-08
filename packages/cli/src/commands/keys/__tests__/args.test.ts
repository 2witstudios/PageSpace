import { describe, expect, it } from 'vitest';
import { KEYS_USE_USAGE_MESSAGE, parseKeysUseArgs, parseTokensCreateArgs, parseTokensRevokeArgs, SAVE_AS_PROFILE_FLAG_RENAMED_MESSAGE } from '../args.js';

describe('parseTokensCreateArgs', () => {
  it('parses no flags as no drives and no --name', () => {
    const result = parseTokensCreateArgs([]);
    expect(result).toEqual({ ok: true, args: { drives: [], name: undefined, showToken: false } });
  });

  it('parses a single --drive with no --role as inherit (role null)', () => {
    const result = parseTokensCreateArgs(['--drive', 'drv1']);
    expect(result).toEqual({ ok: true, args: { drives: [{ id: 'drv1', role: null }], name: undefined, showToken: false } });
  });

  it('maps --role member to MEMBER (case-insensitive)', () => {
    const result = parseTokensCreateArgs(['--drive', 'drv1', '--role', 'Member']);
    expect(result).toEqual({ ok: true, args: { drives: [{ id: 'drv1', role: 'MEMBER' }], name: undefined, showToken: false } });
  });

  it('maps --role admin to ADMIN (case-insensitive)', () => {
    const result = parseTokensCreateArgs(['--drive', 'drv1', '--role', 'ADMIN']);
    expect(result).toEqual({ ok: true, args: { drives: [{ id: 'drv1', role: 'ADMIN' }], name: undefined, showToken: false } });
  });

  it('maps any other --role value to a customRoleId, role null', () => {
    const result = parseTokensCreateArgs(['--drive', 'drv1', '--role', 'role-xyz']);
    expect(result).toEqual({
      ok: true,
      args: { drives: [{ id: 'drv1', role: null, customRoleId: 'role-xyz' }], name: undefined, showToken: false },
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
        name: undefined,
        showToken: false,
      },
    });
  });

  it('parses --name', () => {
    const result = parseTokensCreateArgs(['--drive', 'drv1', '--name', 'ci-bot']);
    expect(result).toEqual({
      ok: true,
      args: { drives: [{ id: 'drv1', role: null }], name: 'ci-bot', showToken: false },
    });
  });

  it('rejects --name with a missing value', () => {
    const result = parseTokensCreateArgs(['--name']);
    expect(result).toEqual({ ok: false, message: 'Flag --name requires a value.' });
  });

  it('rejects a second --name', () => {
    const result = parseTokensCreateArgs(['--name', 'a', '--name', 'b']);
    expect(result).toEqual({ ok: false, message: 'Flag --name was given more than once.' });
  });

  it('rejects the renamed --save-as-profile flag with a dedicated 1.5.0 rename error', () => {
    expect(parseTokensCreateArgs(['--drive', 'drv1', '--save-as-profile', 'ci-bot'])).toEqual({
      ok: false,
      message: '--save-as-profile was renamed to --name in 1.5.0.',
    });
    expect(SAVE_AS_PROFILE_FLAG_RENAMED_MESSAGE).toBe('--save-as-profile was renamed to --name in 1.5.0.');
  });

  it('rejects --save-as-profile=value (equals-joined) with the same rename error, never echoing the value', () => {
    const result = parseTokensCreateArgs(['--save-as-profile=ci-bot']);
    expect(result).toEqual({ ok: false, message: '--save-as-profile was renamed to --name in 1.5.0.' });
    expect(JSON.stringify(result)).not.toContain('ci-bot');
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

  it('parses --show-token as a valueless flag', () => {
    const result = parseTokensCreateArgs(['--drive', 'drv1', '--show-token']);
    expect(result).toEqual({
      ok: true,
      args: { drives: [{ id: 'drv1', role: null }], name: undefined, showToken: true },
    });
  });

  it('rejects a second --show-token', () => {
    const result = parseTokensCreateArgs(['--drive', 'drv1', '--show-token', '--show-token']);
    expect(result).toEqual({ ok: false, message: 'Flag --show-token was given more than once.' });
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

describe('parseKeysUseArgs', () => {
  it('parses a bare key name as an activation', () => {
    expect(parseKeysUseArgs(['agent'])).toEqual({ ok: true, args: { kind: 'activate', name: 'agent' } });
  });

  it('parses --off as a deactivation', () => {
    expect(parseKeysUseArgs(['--off'])).toEqual({ ok: true, args: { kind: 'off' } });
  });

  it('rejects no arguments with a usage message showing both forms', () => {
    const result = parseKeysUseArgs([]);
    expect(result).toEqual({ ok: false, message: KEYS_USE_USAGE_MESSAGE });
    expect(KEYS_USE_USAGE_MESSAGE).toContain('keys use <name>');
    expect(KEYS_USE_USAGE_MESSAGE).toContain('keys use --off');
  });

  it('rejects a name AND --off together', () => {
    expect(parseKeysUseArgs(['agent', '--off']).ok).toBe(false);
    expect(parseKeysUseArgs(['--off', 'agent']).ok).toBe(false);
  });

  it('rejects an unknown flag', () => {
    expect(parseKeysUseArgs(['--bogus']).ok).toBe(false);
  });

  it('rejects extra positional arguments', () => {
    expect(parseKeysUseArgs(['agent', 'extra']).ok).toBe(false);
  });
});
