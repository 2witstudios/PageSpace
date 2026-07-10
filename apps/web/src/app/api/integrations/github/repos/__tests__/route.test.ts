/**
 * Contract tests for GET /api/integrations/github/repos
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockIsAuthError,
  mockGetProviderBySlug,
  mockFindUserConnection,
  mockCreateConfiguredToolExecutor,
  mockExecutor,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockIsAuthError: vi.fn((result: unknown) => result != null && typeof result === 'object' && 'error' in result),
  mockGetProviderBySlug: vi.fn(),
  mockFindUserConnection: vi.fn(),
  mockCreateConfiguredToolExecutor: vi.fn(),
  mockExecutor: vi.fn(),
}));

vi.mock('@/lib/auth/request-auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequest(...args),
}));
vi.mock('@/lib/auth/auth-core', () => ({
  isAuthError: (result: unknown) => mockIsAuthError(result),
}));

vi.mock('@pagespace/db/db', () => ({ db: {} }));

vi.mock('@pagespace/lib/integrations/repositories/provider-repository', () => ({
  getProviderBySlug: (...args: unknown[]) => mockGetProviderBySlug(...args),
}));

vi.mock('@pagespace/lib/integrations/repositories/connection-repository', () => ({
  findUserConnection: (...args: unknown[]) => mockFindUserConnection(...args),
}));

vi.mock('@pagespace/lib/integrations/saga/create-configured-executor', () => ({
  createConfiguredToolExecutor: (...args: unknown[]) => mockCreateConfiguredToolExecutor(...args),
}));

import { GET } from '../route';

const AUTH_OK = { userId: 'user-1' };
const AUTH_DENIED = { error: new Response(null, { status: 401 }) };

function req(query = '') {
  return new Request(`https://x.test/api/integrations/github/repos${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_OK);
  mockCreateConfiguredToolExecutor.mockReturnValue(mockExecutor);
});

describe('GET /api/integrations/github/repos', () => {
  it('given no auth, returns the auth error', async () => {
    mockAuthenticateRequest.mockResolvedValue(AUTH_DENIED);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(mockGetProviderBySlug).not.toHaveBeenCalled();
  });

  it('given no github provider configured, responds connected: false', async () => {
    mockGetProviderBySlug.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
    expect(mockCreateConfiguredToolExecutor).not.toHaveBeenCalled();
  });

  it('given no user connection, responds connected: false', async () => {
    mockGetProviderBySlug.mockResolvedValue({ id: 'provider-1' });
    mockFindUserConnection.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
    expect(mockCreateConfiguredToolExecutor).not.toHaveBeenCalled();
  });

  it('given an inactive connection, responds connected: false without calling the tool', async () => {
    mockGetProviderBySlug.mockResolvedValue({ id: 'provider-1' });
    mockFindUserConnection.mockResolvedValue({ id: 'conn-1', status: 'revoked' });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
    expect(mockCreateConfiguredToolExecutor).not.toHaveBeenCalled();
  });

  it('given an active connection, calls list_repos with type=all and returns the repos', async () => {
    mockGetProviderBySlug.mockResolvedValue({ id: 'provider-1' });
    mockFindUserConnection.mockResolvedValue({ id: 'conn-1', status: 'active' });
    mockExecutor.mockResolvedValue({
      success: true,
      data: [{ name: 'my-repo', full_name: 'org/my-repo', clone_url: 'https://github.com/org/my-repo.git' }],
    });

    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      connected: true,
      repos: [{ name: 'my-repo', full_name: 'org/my-repo', clone_url: 'https://github.com/org/my-repo.git' }],
      page: 1,
    });
    expect(mockExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'conn-1',
        toolName: 'list_repos',
        input: { type: 'all', sort: 'updated', per_page: 100, page: 1 },
      })
    );
  });

  it('given a page query param, passes it through to the tool input', async () => {
    mockGetProviderBySlug.mockResolvedValue({ id: 'provider-1' });
    mockFindUserConnection.mockResolvedValue({ id: 'conn-1', status: 'active' });
    mockExecutor.mockResolvedValue({ success: true, data: [] });

    await GET(req('?page=3'));

    expect(mockExecutor).toHaveBeenCalledWith(
      expect.objectContaining({ input: { type: 'all', sort: 'updated', per_page: 100, page: 3 } })
    );
  });

  it('given an invalid page query param, defaults to page 1', async () => {
    mockGetProviderBySlug.mockResolvedValue({ id: 'provider-1' });
    mockFindUserConnection.mockResolvedValue({ id: 'conn-1', status: 'active' });
    mockExecutor.mockResolvedValue({ success: true, data: [] });

    await GET(req('?page=not-a-number'));

    expect(mockExecutor).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ page: 1 }) })
    );
  });

  it('given the tool call fails, returns 502', async () => {
    mockGetProviderBySlug.mockResolvedValue({ id: 'provider-1' });
    mockFindUserConnection.mockResolvedValue({ id: 'conn-1', status: 'active' });
    mockExecutor.mockResolvedValue({ success: false, error: 'GitHub API rate limited' });

    const res = await GET(req());

    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('GitHub API rate limited');
  });
});
