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
    const result = parseArgv(['tokens', 'create']);
    expectCommand(result);
    expect(result.args).toEqual(['tokens', 'create']);
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

  it('parses flags interleaved before and after the command', () => {
    const result = parseArgv(['--json', 'tokens', 'create', '--yes']);
    expectCommand(result);
    expect(result.args).toEqual(['tokens', 'create']);
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

  it('rejects --host followed immediately by another flag as a missing value', () => {
    const result = parseArgv(['--host', '--json']);
    expect(result.kind).toBe('usage-error');
  });

  it('never echoes a supplied token value back in a usage error message', () => {
    const result = parseArgv(['--token', 'super-secret-value', '--bogus']);
    expect(JSON.stringify(result)).not.toContain('super-secret-value');
  });

  it('passes an unrecognized flag through into args once a command path has started', () => {
    const result = parseArgv(['tokens', 'create', '--name', 'CI bot', '--drive', 'drv1', '--role', 'member']);
    expectCommand(result);
    expect(result.args).toEqual(['tokens', 'create', '--name', 'CI bot', '--drive', 'drv1', '--role', 'member']);
  });

  it('still extracts known global flags interleaved among command-specific ones', () => {
    const result = parseArgv(['tokens', 'create', '--name', 'CI bot', '--json', '--yes']);
    expectCommand(result);
    expect(result.args).toEqual(['tokens', 'create', '--name', 'CI bot']);
    expect(result.flags.json).toBe(true);
    expect(result.flags.yes).toBe(true);
  });

  it('is a pure function: identical input produces a deep-equal result', () => {
    const argv = ['--json', 'tokens', 'create', '--yes'];
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
