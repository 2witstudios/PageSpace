import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * `app-url.ts` has never had a test — every suite that touched it mocked
 * `getAppUrl` wholesale, so its store/env precedence, its https upgrade and its
 * loopback exemption were entirely unexercised. Mock only the two collaborators
 * (electron-store and the build-time identity) so the real logic runs.
 */
const get = vi.fn();
vi.mock('../store', () => ({ store: { get: (key: string) => get(key) } }));

const startPath = vi.fn(() => '/dashboard');
vi.mock('../app-identity', () => ({
  get APP_IDENTITY() {
    return { startPath: startPath() };
  },
}));

import { getAppOrigin, getStartUrl } from '../app-url';

const originalEnv = { ...process.env };

/** Both functions must agree, in every configuration. */
function expectConsistent(): void {
  expect(getStartUrl()).toBe(getAppOrigin() + startPath());
}

describe('getAppOrigin', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockReturnValue(undefined);
    startPath.mockReturnValue('/dashboard');
    delete process.env.PAGESPACE_URL;
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('defaults to the production origin', () => {
    expect(getAppOrigin()).toBe('https://pagespace.ai');
    expectConsistent();
  });

  it('defaults to localhost in development', () => {
    process.env.NODE_ENV = 'development';
    expect(getAppOrigin()).toBe('http://localhost:3000');
    expectConsistent();
  });

  it('uses PAGESPACE_URL when set', () => {
    process.env.PAGESPACE_URL = 'https://self.hosted.example';
    expect(getAppOrigin()).toBe('https://self.hosted.example');
    expectConsistent();
  });

  it('upgrades an insecure PAGESPACE_URL to https', () => {
    process.env.PAGESPACE_URL = 'http://self.hosted.example';
    expect(getAppOrigin()).toBe('https://self.hosted.example');
  });

  it('leaves loopback origins on http', () => {
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000']) {
      process.env.PAGESPACE_URL = origin;
      expect(getAppOrigin()).toBe(origin);
    }
  });

  it('discards any path carried by PAGESPACE_URL', () => {
    process.env.PAGESPACE_URL = 'https://self.hosted.example/base';
    expect(getAppOrigin()).toBe('https://self.hosted.example');
    expect(getStartUrl()).toBe('https://self.hosted.example/dashboard');
  });

  it('takes the origin — and only the origin — from the stored override', () => {
    get.mockReturnValue('https://self.hosted.example/dashboard');
    expect(getAppOrigin()).toBe('https://self.hosted.example');
    expectConsistent();
  });

  it('upgrades an insecure stored override, exempting loopback', () => {
    get.mockReturnValue('http://self.hosted.example/dashboard');
    expect(getAppOrigin()).toBe('https://self.hosted.example');

    get.mockReturnValue('http://localhost:3000/dashboard');
    expect(getAppOrigin()).toBe('http://localhost:3000');
  });

  it('prefers the stored override over PAGESPACE_URL', () => {
    process.env.PAGESPACE_URL = 'https://from-env.example';
    get.mockReturnValue('https://from-store.example/dashboard');
    expect(getAppOrigin()).toBe('https://from-store.example');
  });

  it('ignores a malformed override instead of returning it verbatim', () => {
    process.env.PAGESPACE_URL = 'https://from-env.example';
    for (const bad of ['not a url', '', '/dashboard', 42 as unknown as string]) {
      get.mockReturnValue(bad);
      expect(getAppOrigin()).toBe('https://from-env.example');
    }
  });

  it('falls back to production when the environment is unparseable', () => {
    process.env.PAGESPACE_URL = 'http:// nonsense';
    expect(getAppOrigin()).toBe('https://pagespace.ai');
  });

  it('always returns a parseable http(s) origin with no path', () => {
    for (const value of ['https://a.example/x/y?q=1', 'http://localhost:3000/z', 'garbage']) {
      get.mockReturnValue(value);
      const origin = getAppOrigin();
      const parsed = new URL(origin);
      expect(['http:', 'https:']).toContain(parsed.protocol);
      expect(origin).toBe(parsed.origin);
    }
  });
});

describe('getStartUrl', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockReturnValue(undefined);
    delete process.env.PAGESPACE_URL;
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    startPath.mockReturnValue('/dashboard');
  });

  it('opens PageSpace on the dashboard', () => {
    startPath.mockReturnValue('/dashboard');
    expect(getStartUrl()).toBe('https://pagespace.ai/dashboard');
  });

  it('opens the coder app directly on the Agents console', () => {
    startPath.mockReturnValue('/dashboard/agents');
    expect(getStartUrl()).toBe('https://pagespace.ai/dashboard/agents');
  });

  // The regression test for "the store override supplies the origin, the
  // identity supplies the path". Under the old single-value behaviour a stored
  // override pinned the start path too, so the coder build would have opened on
  // /dashboard.
  it('applies the coder start path on top of a stored override origin', () => {
    startPath.mockReturnValue('/dashboard/agents');
    get.mockReturnValue('https://self.hosted.example/dashboard');
    expect(getStartUrl()).toBe('https://self.hosted.example/dashboard/agents');
  });
});
