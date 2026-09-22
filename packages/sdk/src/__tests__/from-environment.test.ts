/**
 * Phase 3 leaf 3 — `PageSpaceClient.fromEnvironment()`: the zero-config door
 * for an app built in a PageSpace environment (US6, US7), where the platform
 * injects exactly two public values, `PAGESPACE_URL` and `PAGESPACE_CLIENT_ID`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PageSpaceClient } from '../client.js';
import { isPageSpaceConfigError, PageSpaceAuth, type PageSpaceConfigError } from '../auth/pagespace-auth.js';

const ENV = { PAGESPACE_URL: 'https://pagespace.ai', PAGESPACE_CLIENT_ID: 'env_client_1' };
const ORIGIN = 'https://env-abc.preview.pagespace.app';

function configError(run: () => unknown): PageSpaceConfigError {
  try {
    run();
  } catch (error) {
    if (isPageSpaceConfigError(error)) return error;
    throw error;
  }
  throw new Error('expected a PageSpaceConfigError');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('PageSpaceClient.fromEnvironment', () => {
  it('builds a PageSpaceAuth from the two env vars and the page origin + the [D-10] callback path', () => {
    const auth = PageSpaceClient.fromEnvironment({ env: ENV, origin: ORIGIN });

    expect(auth).toBeInstanceOf(PageSpaceAuth);
    expect(auth.baseUrl).toBe('https://pagespace.ai');
    expect(auth.clientId).toBe('env_client_1');
    expect(auth.redirectUri).toBe('https://env-abc.preview.pagespace.app/auth/pagespace/callback');
  });

  it('reads process.env and location.origin when nothing is passed', () => {
    vi.stubEnv('PAGESPACE_URL', ENV.PAGESPACE_URL);
    vi.stubEnv('PAGESPACE_CLIENT_ID', ENV.PAGESPACE_CLIENT_ID);
    vi.stubGlobal('location', { origin: ORIGIN });

    const auth = PageSpaceClient.fromEnvironment();

    expect(auth.clientId).toBe('env_client_1');
    expect(auth.redirectUri).toBe(`${ORIGIN}/auth/pagespace/callback`);
  });

  it('passes the remaining options through (scope, storage, fetch)', () => {
    const auth = PageSpaceClient.fromEnvironment({ env: ENV, origin: ORIGIN, scope: 'profile drive:abc123:member' });

    expect(auth.scope).toBe('profile drive:abc123:member');
  });

  it('fails closed with a typed error naming PAGESPACE_URL when it is absent or blank', () => {
    expect(configError(() => PageSpaceClient.fromEnvironment({ env: { PAGESPACE_CLIENT_ID: 'c' }, origin: ORIGIN })).fields).toEqual(['PAGESPACE_URL']);
    expect(configError(() => PageSpaceClient.fromEnvironment({ env: { ...ENV, PAGESPACE_URL: '  ' }, origin: ORIGIN })).fields).toEqual(['PAGESPACE_URL']);
  });

  it('fails closed naming PAGESPACE_CLIENT_ID when it is absent', () => {
    expect(configError(() => PageSpaceClient.fromEnvironment({ env: { PAGESPACE_URL: ENV.PAGESPACE_URL }, origin: ORIGIN })).fields).toEqual([
      'PAGESPACE_CLIENT_ID',
    ]);
  });

  it('names both when both are absent', () => {
    expect(configError(() => PageSpaceClient.fromEnvironment({ env: {}, origin: ORIGIN })).fields).toEqual(['PAGESPACE_URL', 'PAGESPACE_CLIENT_ID']);
  });

  it('rejects a PAGESPACE_URL that is not https (plain http only on loopback)', () => {
    expect(configError(() => PageSpaceClient.fromEnvironment({ env: { ...ENV, PAGESPACE_URL: 'http://pagespace.ai' }, origin: ORIGIN })).fields).toEqual([
      'PAGESPACE_URL',
    ]);
    expect(PageSpaceClient.fromEnvironment({ env: { ...ENV, PAGESPACE_URL: 'http://localhost:3000' }, origin: ORIGIN }).baseUrl).toBe('http://localhost:3000');
  });

  it('fails closed naming origin when there is no page origin to redirect back to', () => {
    vi.stubGlobal('location', undefined);

    expect(configError(() => PageSpaceClient.fromEnvironment({ env: ENV })).fields).toEqual(['origin']);
    expect(configError(() => PageSpaceClient.fromEnvironment({ env: ENV, origin: 'null' })).fields).toEqual(['origin']);
  });

  it('never echoes an env value in its error message', () => {
    const error = configError(() => PageSpaceClient.fromEnvironment({ env: { PAGESPACE_URL: 'http://secret-host.example', PAGESPACE_CLIENT_ID: 'c' }, origin: ORIGIN }));

    expect(error.message).not.toContain('secret-host');
  });
});
