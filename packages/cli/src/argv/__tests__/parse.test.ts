import { describe, expect, it } from 'vitest';
import { parseArgv } from '@pagespace/cli';
import type { CommandIntent } from '@pagespace/cli';

function expectCommand(result: ReturnType<typeof parseArgv>): asserts result is CommandIntent {
  expect(result.kind).toBe('command');
}

describe('parseArgv', () => {
  it('parses a bare invocation with no args and all-default flags', () => {
    const result = parseArgv([]);
    expectCommand(result);
    expect(result.args).toEqual([]);
    expect(result.flags).toEqual({
      json: false,
      host: undefined,
      token: undefined,
      key: undefined,
      yes: false,
      all: false,
      force: false,
      help: false,
      version: false,
      device: false,
    });
  });

  it('parses a single-word command', () => {
    const result = parseArgv(['help']);
    expectCommand(result);
    expect(result.args).toEqual(['help']);
  });

  it('parses a multi-segment command path', () => {
    const result = parseArgv(['keys', 'create']);
    expectCommand(result);
    expect(result.args).toEqual(['keys', 'create']);
  });

  it('parses --json as a boolean flag', () => {
    const result = parseArgv(['help', '--json']);
    expectCommand(result);
    expect(result.flags.json).toBe(true);
  });

  it('parses --yes as a boolean flag', () => {
    const result = parseArgv(['--yes']);
    expectCommand(result);
    expect(result.flags.yes).toBe(true);
  });

  it('parses --help as a boolean flag', () => {
    const result = parseArgv(['--help']);
    expectCommand(result);
    expect(result.flags.help).toBe(true);
  });

  it('parses --version as a boolean flag', () => {
    const result = parseArgv(['--version']);
    expectCommand(result);
    expect(result.flags.version).toBe(true);
  });

  it('parses --all as a boolean flag', () => {
    const result = parseArgv(['logout', '--all']);
    expectCommand(result);
    expect(result.flags.all).toBe(true);
  });

  it('parses --force as a boolean flag', () => {
    const result = parseArgv(['logout', '--force']);
    expectCommand(result);
    expect(result.flags.force).toBe(true);
  });

  it('parses --device as a boolean flag', () => {
    const result = parseArgv(['login', '--device']);
    expectCommand(result);
    expect(result.args).toEqual(['login']);
    expect(result.flags.device).toBe(true);
  });

  it('parses --host with its value', () => {
    const result = parseArgv(['--host', 'https://selfhosted.example']);
    expectCommand(result);
    expect(result.flags.host).toBe('https://selfhosted.example');
  });

  it('parses --token with its value', () => {
    const result = parseArgv(['--token', 'ps_sess_abc123']);
    expectCommand(result);
    expect(result.flags.token).toBe('ps_sess_abc123');
  });

  it('parses --key with its value', () => {
    const result = parseArgv(['--key', 'work']);
    expectCommand(result);
    expect(result.flags.key).toBe('work');
  });

  it('parses flags interleaved before and after the command', () => {
    const result = parseArgv(['--json', 'keys', 'create', '--yes']);
    expectCommand(result);
    expect(result.args).toEqual(['keys', 'create']);
    expect(result.flags.json).toBe(true);
    expect(result.flags.yes).toBe(true);
  });

  it('rejects an unknown flag as a usage error', () => {
    const result = parseArgv(['--bogus']);
    expect(result).toEqual({ kind: 'usage-error', message: 'Unknown flag: --bogus' });
  });

  it('rejects --host with a missing value as a usage error', () => {
    const result = parseArgv(['--host']);
    expect(result.kind).toBe('usage-error');
  });

  it('rejects --token with a missing value as a usage error', () => {
    const result = parseArgv(['--token']);
    expect(result.kind).toBe('usage-error');
  });

  it('rejects --key with a missing value as a usage error', () => {
    const result = parseArgv(['--key']);
    expect(result.kind).toBe('usage-error');
  });

  it('parses --key=value (equals-joined) the same as space-separated', () => {
    const result = parseArgv(['--key=work']);
    expectCommand(result);
    expect(result.flags.key).toBe('work');
  });

  it('rejects the renamed --profile flag with a dedicated 1.5.0 rename error', () => {
    expect(parseArgv(['--profile', 'work'])).toEqual({
      kind: 'usage-error',
      message: '--profile was renamed to --key in 1.5.0.',
    });
  });

  it('rejects --profile=value (equals-joined) with the same rename error, never echoing the value', () => {
    const result = parseArgv(['--profile=work']);
    expect(result).toEqual({ kind: 'usage-error', message: '--profile was renamed to --key in 1.5.0.' });
    expect(JSON.stringify(result)).not.toContain('work');
  });

  it('rejects --profile even after a command path has started (it was a global flag, never a passthrough)', () => {
    const result = parseArgv(['whoami', '--profile', 'work']);
    expect(result).toEqual({ kind: 'usage-error', message: '--profile was renamed to --key in 1.5.0.' });
  });

  it('rejects --host followed immediately by another flag as a missing value', () => {
    const result = parseArgv(['--host', '--json']);
    expect(result.kind).toBe('usage-error');
  });

  it('never echoes a supplied token value back in a usage error message', () => {
    const result = parseArgv(['--token', 'super-secret-value', '--bogus']);
    expect(JSON.stringify(result)).not.toContain('super-secret-value');
  });

  it('passes an unrecognized flag through into args once a command path has started', () => {
    const result = parseArgv(['keys', 'create', '--name', 'CI bot', '--drive', 'drv1', '--role', 'member']);
    expectCommand(result);
    expect(result.args).toEqual(['keys', 'create', '--name', 'CI bot', '--drive', 'drv1', '--role', 'member']);
  });

  it('still extracts known global flags interleaved among command-specific ones', () => {
    const result = parseArgv(['keys', 'create', '--name', 'CI bot', '--json', '--yes']);
    expectCommand(result);
    expect(result.args).toEqual(['keys', 'create', '--name', 'CI bot']);
    expect(result.flags.json).toBe(true);
    expect(result.flags.yes).toBe(true);
  });

  it('is a pure function: identical input produces a deep-equal result', () => {
    const argv = ['--json', 'keys', 'create', '--yes'];
    expect(parseArgv(argv)).toEqual(parseArgv(argv));
  });

  it('parses --host=value (equals-joined) the same as space-separated', () => {
    const result = parseArgv(['--host=https://selfhosted.example']);
    expectCommand(result);
    expect(result.flags.host).toBe('https://selfhosted.example');
  });

  it('parses --token=value (equals-joined) the same as space-separated', () => {
    const result = parseArgv(['--token=ps_sess_abc123']);
    expectCommand(result);
    expect(result.flags.token).toBe('ps_sess_abc123');
  });

  it('accepts a --host=value that itself starts with a dash (only possible via the equals form)', () => {
    const result = parseArgv(['--host=-not-actually-a-flag']);
    expectCommand(result);
    expect(result.flags.host).toBe('-not-actually-a-flag');
  });

  it('rejects --json=<value> as an unknown flag — boolean flags do not accept an equals-joined value', () => {
    const result = parseArgv(['--json=true']);
    expect(result).toEqual({ kind: 'usage-error', message: 'Unknown flag: --json=true' });
  });

  it('rejects --yes=<value> as an unknown flag rather than silently coercing a typo to false', () => {
    const result = parseArgv(['--yes=oops']);
    expect(result.kind).toBe('usage-error');
  });

  it('rejects --host= with an empty value as a usage error', () => {
    const result = parseArgv(['--host=']);
    expect(result.kind).toBe('usage-error');
  });

  it('never echoes an equals-joined token value back in a usage error message', () => {
    const result = parseArgv(['--token=super-secret-value', '--bogus']);
    expect(JSON.stringify(result)).not.toContain('super-secret-value');
  });
});

/**
 * `--timeout` exists because per-operation deadlines used to be unraisable:
 * `agents.ask` declares 120s and the client applied it in preference to any
 * caller setting, so a consult that outran it was billed, completed, and
 * unreachable with no way to wait longer. Seconds in (a human unit at a
 * prompt), milliseconds out (what the SDK option takes).
 */
describe('parseArgv — --timeout', () => {
  it('converts seconds to milliseconds', () => {
    const parsed = parseArgv(['agents', 'ask', 'a1', 'q', '--timeout', '600']);
    expect(parsed.kind).toBe('command');
    expect((parsed as CommandIntent).flags.timeoutMs).toBe(600_000);
  });

  it('accepts the equals-joined form', () => {
    const parsed = parseArgv(['agents', 'ask', 'a1', 'q', '--timeout=90']);
    expect((parsed as CommandIntent).flags.timeoutMs).toBe(90_000);
  });

  it('accepts a fractional number of seconds', () => {
    const parsed = parseArgv(['whoami', '--timeout=1.5']);
    expect((parsed as CommandIntent).flags.timeoutMs).toBe(1500);
  });

  it('is undefined when not given, so each operation keeps its own default', () => {
    const parsed = parseArgv(['agents', 'ask', 'a1', 'q']);
    expect((parsed as CommandIntent).flags.timeoutMs).toBeUndefined();
  });

  /**
   * Rejected rather than defaulted. Silently substituting the fallback for
   * `--timeout abc` would make a caller who asked to wait LONGER wait less —
   * the exact failure they were trying to avoid, now silent.
   */
  it.each([['abc'], ['0'], ['-5'], ['NaN']])('rejects %s as a usage error rather than defaulting', (value) => {
    const parsed = parseArgv(['whoami', `--timeout=${value}`]);
    expect(parsed.kind).toBe('usage-error');
    expect((parsed as { message: string }).message).toContain('--timeout');
  });

  /**
   * Validated AFTER conversion, because conversion is where the unusable
   * values come from. `0.0001` is a positive finite number of SECONDS that
   * rounds to 0ms; `1e308` is finite until multiplied by 1000. Both would
   * hand the client a deadline that aborts every request immediately — and
   * because an explicit timeout outranks each operation's own default, the
   * caller asking to wait LONGER is the one whose requests stop working. A
   * pre-conversion check cannot see either of them.
   */
  it.each([
    ['a sub-millisecond value that rounds to 0ms', '0.0001'],
    ['a value that rounds to 0ms exactly at the boundary', '0.0004'],
    ['a value that overflows to Infinity when scaled', '1e308'],
    ['a value beyond setTimeout\'s 2^31-1 ms ceiling', '99999999'],
  ])('rejects %s', (_label, value) => {
    const parsed = parseArgv(['whoami', `--timeout=${value}`]);
    expect(parsed.kind).toBe('usage-error');
  });

  it('accepts the smallest value that survives conversion', () => {
    const parsed = parseArgv(['whoami', '--timeout=0.001']);
    expect((parsed as CommandIntent).flags.timeoutMs).toBe(1);
  });

  it('accepts the largest value setTimeout honours', () => {
    const parsed = parseArgv(['whoami', '--timeout=2147483']);
    expect((parsed as CommandIntent).flags.timeoutMs).toBe(2_147_483_000);
  });

  it('requires a value', () => {
    const parsed = parseArgv(['whoami', '--timeout']);
    expect(parsed.kind).toBe('usage-error');
  });
});
