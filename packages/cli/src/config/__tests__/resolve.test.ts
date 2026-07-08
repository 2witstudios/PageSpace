import { describe, expect, it } from 'vitest';
import { DEFAULT_HOST, resolveConfig } from '@pagespace/cli';

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
