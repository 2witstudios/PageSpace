import { describe, expect, it } from 'vitest';
import { assertSecureHost, bridgeSocketUrl, isLoopbackHost } from '../secure-host.js';

describe('secure-host (CWE-319): https:// and wss:// only, with the CLI\'s own RFC 8252 loopback exception for local development', () => {
  it('accepts https hosts unchanged', () => {
    expect(assertSecureHost('https://pagespace.ai')).toBe('https://pagespace.ai');
    expect(assertSecureHost('https://ps.example.com:8443')).toBe('https://ps.example.com:8443');
  });

  it.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'])('accepts plaintext ONLY for the loopback hosts the OAuth flow already trusts: %s', (host) => {
    expect(assertSecureHost(host)).toBe(host);
    expect(isLoopbackHost(new URL(host).hostname)).toBe(true);
  });

  it.each(['http://pagespace.ai', 'http://10.0.0.5:3000', 'http://ps.local', 'ftp://pagespace.ai', 'not a url'])('refuses %s with a message naming https', (host) => {
    expect(() => assertSecureHost(host)).toThrow(/https/);
  });

  it('bridgeSocketUrl derives wss:// from https and ws:// only from a loopback http host', () => {
    expect(bridgeSocketUrl('https://pagespace.ai', 'env 1')).toBe('wss://pagespace.ai/api/env-bridge/ws?envId=env%201');
    expect(bridgeSocketUrl('http://localhost:3000', 'env_1')).toBe('ws://localhost:3000/api/env-bridge/ws?envId=env_1');
    expect(() => bridgeSocketUrl('http://pagespace.ai', 'env_1')).toThrow(/https/);
  });
});
