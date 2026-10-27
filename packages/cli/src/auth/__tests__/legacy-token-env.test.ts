import { describe, expect, it } from 'vitest';
import { resolveEnvToken } from '../legacy-token-env.js';

describe('resolveEnvToken — pure legacy PAGESPACE_AUTH_TOKEN fallback', () => {
  it('uses PAGESPACE_TOKEN when present, with no deprecation notice', () => {
    const result = resolveEnvToken({ PAGESPACE_TOKEN: 'ps_new' });
    expect(result).toEqual({ token: 'ps_new', deprecationNotice: null });
  });

  it('falls back to the legacy PAGESPACE_AUTH_TOKEN var when PAGESPACE_TOKEN is absent, with a deprecation notice', () => {
    const result = resolveEnvToken({ PAGESPACE_AUTH_TOKEN: 'ps_legacy' });
    expect(result.token).toBe('ps_legacy');
    expect(result.deprecationNotice).toMatch(/PAGESPACE_AUTH_TOKEN/);
    expect(result.deprecationNotice).toMatch(/PAGESPACE_TOKEN/);
  });

  it('prefers PAGESPACE_TOKEN over the legacy var when both are present, with no notice', () => {
    const result = resolveEnvToken({ PAGESPACE_TOKEN: 'ps_new', PAGESPACE_AUTH_TOKEN: 'ps_legacy' });
    expect(result).toEqual({ token: 'ps_new', deprecationNotice: null });
  });

  it('treats a whitespace-only PAGESPACE_TOKEN as absent and falls back to the legacy var', () => {
    const result = resolveEnvToken({ PAGESPACE_TOKEN: '   ', PAGESPACE_AUTH_TOKEN: 'ps_legacy' });
    expect(result.token).toBe('ps_legacy');
  });

  it('treats a whitespace-only legacy var as absent too', () => {
    const result = resolveEnvToken({ PAGESPACE_AUTH_TOKEN: '   ' });
    expect(result).toEqual({ token: undefined, deprecationNotice: null });
  });

  it('returns no token and no notice when neither var is set', () => {
    const result = resolveEnvToken({});
    expect(result).toEqual({ token: undefined, deprecationNotice: null });
  });

  it('never echoes the legacy token value inside the deprecation notice', () => {
    const result = resolveEnvToken({ PAGESPACE_AUTH_TOKEN: 'ps_super_secret_value' });
    expect(result.deprecationNotice).not.toContain('ps_super_secret_value');
  });
});
