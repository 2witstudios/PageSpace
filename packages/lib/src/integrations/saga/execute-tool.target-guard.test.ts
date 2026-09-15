/**
 * Execute Tool Saga — target guard tests.
 *
 * Unlike execute-tool.test.ts these run the REAL request builder, auth and HTTP
 * executor, stubbing only `fetch` and DNS, so they prove that a connection whose
 * stored baseUrlOverride points at a private address is refused before any
 * request leaves the process — and that builtin providers still reach their
 * real base URL.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolCallRequest } from '../types';
import { executeToolSaga, type ExecuteToolDependencies } from './execute-tool';
import { builtinProviders } from '../providers/builtin-providers';

vi.mock('dns', () => ({
  promises: {
    lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
  },
}));

vi.mock('../credentials/encrypt-credentials', () => ({
  decryptCredentials: vi.fn(async () => ({
    token: 'decrypted-token',
    apiKey: 'decrypted-key',
    accessToken: 'decrypted-access',
    webhookSecret: 'decrypted-secret',
  })),
}));

vi.mock('../rate-limit/integration-rate-limiter', () => ({
  checkIntegrationRateLimit: vi.fn(async () => ({ allowed: true })),
}));

import { promises as dns } from 'dns';

const mockLoadConnection = vi.fn();
const mockLogAudit = vi.fn(async () => undefined);
const deps: ExecuteToolDependencies = { loadConnection: mockLoadConnection, logAudit: mockLogAudit };

const okJson = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  }) as unknown as Response;

const fetchSpy = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

const connectionFor = (providerSlug: keyof typeof builtinProviders, baseUrlOverride: string | null) => ({
  id: 'conn-1',
  providerId: providerSlug,
  name: 'Test',
  status: 'active',
  credentials: { token: 'enc' },
  baseUrlOverride,
  provider: {
    id: providerSlug,
    slug: providerSlug,
    name: providerSlug,
    config: builtinProviders[providerSlug],
  },
});

const requestFor = (toolName: string, input: Record<string, unknown> = {}): ToolCallRequest => ({
  userId: 'user-1',
  driveId: 'drive-1',
  connectionId: 'conn-1',
  agentId: 'agent-1',
  toolName,
  input,
});

describe('executeToolSaga target guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchSpy);
    fetchSpy.mockResolvedValue(okJson({ ok: true }));
    vi.mocked(dns.lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('given a stored override that is a private IP literal, should refuse before any request', async () => {
    mockLoadConnection.mockResolvedValue(connectionFor('github', 'http://10.0.0.5:8080'));

    const result = await executeToolSaga(requestFor('list_repos'), deps);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('blocked_target');
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      errorType: 'BLOCKED_TARGET',
    }));
  });

  it('given a stored override whose hostname now resolves to a private IP, should refuse before any request', async () => {
    vi.mocked(dns.lookup).mockResolvedValueOnce([{ address: '172.16.4.4', family: 4 }] as never);
    mockLoadConnection.mockResolvedValue(connectionFor('github', 'https://ghe.corp.example/api/v3'));

    const result = await executeToolSaga(requestFor('list_repos'), deps);

    expect(dns.lookup).toHaveBeenCalledWith('ghe.corp.example', { all: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('blocked_target');
  });

  it('given a stored override pointing at the cloud metadata address, should refuse before any request', async () => {
    mockLoadConnection.mockResolvedValue(connectionFor('generic-webhook', 'http://169.254.169.254/latest'));

    const result = await executeToolSaga(requestFor('send_get_webhook', { path: 'meta-data' }), deps);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('blocked_target');
  });

  it('given an upstream redirect to another origin, should not follow it with credentials', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 302,
      statusText: 'Found',
      headers: new Headers({ location: 'https://evil.example/collect' }),
      json: () => Promise.resolve(null),
      text: () => Promise.resolve(''),
    } as unknown as Response);
    mockLoadConnection.mockResolvedValue(connectionFor('github', null));

    const result = await executeToolSaga(requestFor('list_repos'), deps);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.github.com/user/repos');
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('blocked_target');
  });

  describe('builtin providers still execute against their real base URL', () => {
    const cases: Array<{ slug: keyof typeof builtinProviders; tool: string; input: Record<string, unknown>; override: string | null; expectedPrefix: string; authHeader: string }> = [
      { slug: 'github', tool: 'list_repos', input: {}, override: null, expectedPrefix: 'https://api.github.com/user/repos', authHeader: 'Authorization' },
      { slug: 'slack', tool: 'list_channels', input: {}, override: null, expectedPrefix: 'https://slack.com/api/conversations.list', authHeader: 'Authorization' },
      { slug: 'notion', tool: 'search', input: {}, override: null, expectedPrefix: 'https://api.notion.com/v1/search', authHeader: 'Authorization' },
      { slug: 'generic-webhook', tool: 'send_get_webhook', input: { path: 'events' }, override: 'https://hooks.example.com/base', expectedPrefix: 'https://hooks.example.com/base/events', authHeader: 'X-Webhook-Secret' },
    ];

    for (const c of cases) {
      it(`given ${c.slug}, should fetch ${c.expectedPrefix} with its credential header`, async () => {
        mockLoadConnection.mockResolvedValue(connectionFor(c.slug, c.override));

        const result = await executeToolSaga(requestFor(c.tool, c.input), deps);

        expect(result.success).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0];
        expect(url.startsWith(c.expectedPrefix)).toBe(true);
        expect((init.headers as Record<string, string>)[c.authHeader]).toBeTruthy();
      });
    }
  });
});
