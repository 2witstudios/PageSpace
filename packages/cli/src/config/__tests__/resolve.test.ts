import { describe, expect, it } from 'vitest';
import { DEFAULT_HOST, resolveConfig, resolveTimeoutSetting } from '@pagespace/cli';

describe('resolveConfig', () => {
  it('defaults to https://pagespace.ai when nothing else is provided', () => {
    const config = resolveConfig({ flags: {}, env: {}, credential: null });
    expect(config.host).toBe(DEFAULT_HOST);
    expect(config.host).toBe('https://pagespace.ai');
    expect(config.token).toBeUndefined();
  });

  it('prefers the loaded stored credential over defaults', () => {
    const config = resolveConfig({
      flags: {},
      env: {},
      credential: { host: 'https://from-credential.example', token: 'ps_sess_credential' },
    });
    expect(config.host).toBe('https://from-credential.example');
    expect(config.token).toBe('ps_sess_credential');
  });

  it('prefers env over the loaded stored credential', () => {
    const config = resolveConfig({
      flags: {},
      env: { PAGESPACE_API_URL: 'https://from-env.example', PAGESPACE_TOKEN: 'ps_sess_env' },
      credential: { host: 'https://from-credential.example', token: 'ps_sess_credential' },
    });
    expect(config.host).toBe('https://from-env.example');
    expect(config.token).toBe('ps_sess_env');
  });

  it('prefers flags over env and the loaded stored credential', () => {
    const config = resolveConfig({
      flags: { host: 'https://from-flag.example', token: 'ps_sess_flag' },
      env: { PAGESPACE_API_URL: 'https://from-env.example', PAGESPACE_TOKEN: 'ps_sess_env' },
      credential: { host: 'https://from-credential.example', token: 'ps_sess_credential' },
    });
    expect(config.host).toBe('https://from-flag.example');
    expect(config.token).toBe('ps_sess_flag');
  });

  it('falls through per-field independently (flag host, env token)', () => {
    const config = resolveConfig({
      flags: { host: 'https://from-flag.example' },
      env: { PAGESPACE_TOKEN: 'ps_sess_env' },
      credential: { host: 'https://from-credential.example', token: 'ps_sess_credential' },
    });
    expect(config.host).toBe('https://from-flag.example');
    expect(config.token).toBe('ps_sess_env');
  });

  it('is a pure function', () => {
    const sources = {
      flags: { host: 'https://a.example' },
      env: { PAGESPACE_TOKEN: 't' },
      credential: null,
    };
    expect(resolveConfig(sources)).toEqual(resolveConfig(sources));
  });
});

/**
 * The env var's audience is the MCP server's config file: `pagespace mcp`
 * builds the same client every CLI verb uses, so this is the one place an MCP
 * host can raise the deadline for the `ask_agent` consultations it runs.
 */
describe('resolveTimeoutSetting', () => {
  it('prefers the flag over the environment', () => {
    expect(resolveTimeoutSetting(5_000, { PAGESPACE_TIMEOUT_MS: '99000' })).toBe(5_000);
  });

  it('falls back to the environment when no flag was given', () => {
    expect(resolveTimeoutSetting(undefined, { PAGESPACE_TIMEOUT_MS: '99000' })).toBe(99_000);
  });

  it('tolerates surrounding whitespace', () => {
    expect(resolveTimeoutSetting(undefined, { PAGESPACE_TIMEOUT_MS: ' 45000 ' })).toBe(45_000);
  });

  /**
   * Undefined, not a number: passing a number unconditionally would make the
   * client's timeout EXPLICIT for every command and so beat every operation's
   * own default — silently dropping `agents.ask` from 120s to 30s for callers
   * who set nothing at all.
   */
  it('returns undefined when neither source is set, leaving operation defaults intact', () => {
    expect(resolveTimeoutSetting(undefined, {})).toBeUndefined();
  });

  /**
   * A bad flag is a typo worth stopping for (parseArgv rejects it); a stale
   * env var in a shell profile must not make every command in that shell
   * unrunnable.
   */
  it.each([['abc'], ['0'], ['-1'], ['']])('ignores an unusable env value (%s) rather than failing the command', (value) => {
    expect(resolveTimeoutSetting(undefined, { PAGESPACE_TIMEOUT_MS: value })).toBeUndefined();
  });
});
