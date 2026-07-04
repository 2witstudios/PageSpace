import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, parseArgv } from '@pagespace/cli';
import type { CredentialStore, HostCredential } from '@pagespace/cli';
import { createFakeContext, createRecordingSink } from '../../__tests__/fake-context.js';
import { createMcpHandler, resolveMcpEnvToken } from '../mcp.js';

function commandIntent(argv: string[]) {
  const intent = parseArgv(argv);
  if (intent.kind !== 'command') throw new Error('expected command');
  return intent;
}

function fakeStore(initial: Map<string, HostCredential> = new Map()): CredentialStore {
  return {
    get: async (host) => initial.get(host) ?? null,
    set: async (host, credential) => {
      initial.set(host, credential);
    },
    delete: async (host) => {
      initial.delete(host);
    },
    list: async () => [...initial.entries()].map(([host, credential]) => ({ host, tokenPrefix: credential.refreshToken.slice(0, 12) })),
  };
}

function baseDeps(store: CredentialStore, transport: ReturnType<typeof InMemoryTransport.createLinkedPair>[0]) {
  return {
    createCredentialStore: () => store,
    discoverMetadata: async () => ({ tokenEndpoint: 'https://pagespace.ai/api/oauth/token' }),
    createRefreshAccessToken: () => async () => ({
      accessToken: 'ps_at_fresh',
      accessExpiresAt: Date.now() + 900_000,
      refreshToken: 'ps_rt_rotated',
      refreshExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    }),
    createTransport: () => transport,
    now: () => Date.parse('2026-07-03T00:00:00.000Z'),
  };
}

describe('resolveMcpEnvToken — pure legacy-env-var fallback', () => {
  it('uses PAGESPACE_TOKEN when present, with no deprecation notice', () => {
    const result = resolveMcpEnvToken({ PAGESPACE_TOKEN: 'ps_new' });
    expect(result).toEqual({ token: 'ps_new', deprecationNotice: null });
  });

  it('falls back to the legacy PAGESPACE_AUTH_TOKEN var when PAGESPACE_TOKEN is absent, with a deprecation notice', () => {
    const result = resolveMcpEnvToken({ PAGESPACE_AUTH_TOKEN: 'ps_legacy' });
    expect(result.token).toBe('ps_legacy');
    expect(result.deprecationNotice).toMatch(/PAGESPACE_AUTH_TOKEN/);
    expect(result.deprecationNotice).toMatch(/PAGESPACE_TOKEN/);
  });

  it('prefers PAGESPACE_TOKEN over the legacy var when both are present, with no notice', () => {
    const result = resolveMcpEnvToken({ PAGESPACE_TOKEN: 'ps_new', PAGESPACE_AUTH_TOKEN: 'ps_legacy' });
    expect(result).toEqual({ token: 'ps_new', deprecationNotice: null });
  });

  it('treats a whitespace-only PAGESPACE_TOKEN as absent and falls back to the legacy var', () => {
    const result = resolveMcpEnvToken({ PAGESPACE_TOKEN: '   ', PAGESPACE_AUTH_TOKEN: 'ps_legacy' });
    expect(result.token).toBe('ps_legacy');
  });

  it('returns no token and no notice when neither var is set', () => {
    const result = resolveMcpEnvToken({});
    expect(result).toEqual({ token: undefined, deprecationNotice: null });
  });

  it('never echoes the legacy token value inside the deprecation notice', () => {
    const result = resolveMcpEnvToken({ PAGESPACE_AUTH_TOKEN: 'ps_super_secret_value' });
    expect(result.deprecationNotice).not.toContain('ps_super_secret_value');
  });
});

describe('createMcpHandler — auth precedence + fail-closed + stdio wiring', () => {
  it('fails closed with EXIT_RUNTIME_ERROR and an actionable message when no credential source is available', async () => {
    const [serverTransport] = InMemoryTransport.createLinkedPair();
    const handler = createMcpHandler(baseDeps(fakeStore(), serverTransport));

    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, env: {} });
    const code = await handler(ctx, commandIntent(['mcp']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toMatch(/pagespace login|PAGESPACE_TOKEN/);
  });

  it('writes the legacy-env deprecation notice to stderr (never stdout) and never leaks the token value', async () => {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handler = createMcpHandler(baseDeps(fakeStore(), serverTransport));

    const stdout = createRecordingSink();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stdout, stderr, env: { PAGESPACE_AUTH_TOKEN: 'ps_legacy_secret' } });

    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [code] = await Promise.all([handler(ctx, commandIntent(['mcp'])), client.connect(clientTransport)]);

    expect(code).toBe(EXIT_SUCCESS);
    expect(stderr.lines.join('')).toMatch(/PAGESPACE_AUTH_TOKEN/);
    expect(stdout.lines.join('')).toBe('');
    expect([...stdout.lines, ...stderr.lines].join('')).not.toContain('ps_legacy_secret');
  });

  it('an explicit --token flag takes precedence and serves a working MCP server over the injected transport', async () => {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handler = createMcpHandler(baseDeps(fakeStore(), serverTransport));

    const ctx = createFakeContext({ env: {} });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [code] = await Promise.all([handler(ctx, commandIntent(['mcp', '--token', 'ps_flag_token'])), client.connect(clientTransport)]);

    expect(code).toBe(EXIT_SUCCESS);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(60);
  });

  it('succeeds from a stored profile credential (silent refresh) when no flag/env token is present', async () => {
    const store = fakeStore(
      new Map([
        [
          'https://pagespace.ai',
          { refreshToken: 'ps_rt', clientId: 'pagespace-cli', scopes: ['account'], createdAt: '2026-01-01T00:00:00.000Z' } as HostCredential,
        ],
      ]),
    );
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handler = createMcpHandler(baseDeps(store, serverTransport));

    const ctx = createFakeContext({ env: {} });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [code] = await Promise.all([handler(ctx, commandIntent(['mcp'])), client.connect(clientTransport)]);

    expect(code).toBe(EXIT_SUCCESS);
    expect((await store.get('https://pagespace.ai'))?.refreshToken).toBe('ps_rt_rotated');
  });
});
