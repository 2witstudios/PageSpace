import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveGitHubTokenForSandbox } from '../github-token';

const mockGetProviderBySlug = vi.fn();
const mockFindUserConnection = vi.fn();
const mockDecryptCredentials = vi.fn();

vi.mock('../../../integrations/repositories/provider-repository', () => ({
  getProviderBySlug: (...args: unknown[]) => mockGetProviderBySlug(...args),
}));

vi.mock('../../../integrations/repositories/connection-repository', () => ({
  findUserConnection: (...args: unknown[]) => mockFindUserConnection(...args),
}));

vi.mock('../../../integrations/credentials/encrypt-credentials', () => ({
  decryptCredentials: (...args: unknown[]) => mockDecryptCredentials(...args),
}));

const fakeDb = {} as never;
const userId = 'user-123';
const providerId = 'provider-github';

const activeConnection = {
  id: 'conn-1',
  userId,
  providerId,
  status: 'active',
  credentials: { accessToken: 'encrypted-token' },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveGitHubTokenForSandbox', () => {
  it('returns null when getProviderBySlug resolves null', async () => {
    mockGetProviderBySlug.mockResolvedValue(null);
    const result = await resolveGitHubTokenForSandbox({ userId, db: fakeDb });
    expect(result).toBeNull();
    expect(mockFindUserConnection).not.toHaveBeenCalled();
  });

  it('returns null when findUserConnection resolves null', async () => {
    mockGetProviderBySlug.mockResolvedValue({ id: providerId });
    mockFindUserConnection.mockResolvedValue(null);
    const result = await resolveGitHubTokenForSandbox({ userId, db: fakeDb });
    expect(result).toBeNull();
    expect(mockDecryptCredentials).not.toHaveBeenCalled();
  });

  it('returns null when connection status is inactive', async () => {
    mockGetProviderBySlug.mockResolvedValue({ id: providerId });
    mockFindUserConnection.mockResolvedValue({ ...activeConnection, status: 'inactive' });
    const result = await resolveGitHubTokenForSandbox({ userId, db: fakeDb });
    expect(result).toBeNull();
  });

  it('returns null when connection status is pending', async () => {
    mockGetProviderBySlug.mockResolvedValue({ id: providerId });
    mockFindUserConnection.mockResolvedValue({ ...activeConnection, status: 'pending' });
    const result = await resolveGitHubTokenForSandbox({ userId, db: fakeDb });
    expect(result).toBeNull();
  });

  it('returns null when connection credentials is null', async () => {
    mockGetProviderBySlug.mockResolvedValue({ id: providerId });
    mockFindUserConnection.mockResolvedValue({ ...activeConnection, credentials: null });
    const result = await resolveGitHubTokenForSandbox({ userId, db: fakeDb });
    expect(result).toBeNull();
    expect(mockDecryptCredentials).not.toHaveBeenCalled();
  });

  it('returns null when connection credentials is empty object', async () => {
    mockGetProviderBySlug.mockResolvedValue({ id: providerId });
    mockFindUserConnection.mockResolvedValue({ ...activeConnection, credentials: {} });
    const result = await resolveGitHubTokenForSandbox({ userId, db: fakeDb });
    expect(result).toBeNull();
    expect(mockDecryptCredentials).not.toHaveBeenCalled();
  });

  it('returns the accessToken when connection is active with valid credentials', async () => {
    mockGetProviderBySlug.mockResolvedValue({ id: providerId });
    mockFindUserConnection.mockResolvedValue(activeConnection);
    mockDecryptCredentials.mockResolvedValue({ accessToken: 'ghp_real_token' });
    const result = await resolveGitHubTokenForSandbox({ userId, db: fakeDb });
    expect(result).toBe('ghp_real_token');
  });

  it('returns null (does not throw) when decryptCredentials throws', async () => {
    mockGetProviderBySlug.mockResolvedValue({ id: providerId });
    mockFindUserConnection.mockResolvedValue(activeConnection);
    mockDecryptCredentials.mockRejectedValue(new Error('decrypt failed'));
    const result = await resolveGitHubTokenForSandbox({ userId, db: fakeDb });
    expect(result).toBeNull();
  });

  it('returns null when decrypted credentials contain no accessToken', async () => {
    mockGetProviderBySlug.mockResolvedValue({ id: providerId });
    mockFindUserConnection.mockResolvedValue(activeConnection);
    mockDecryptCredentials.mockResolvedValue({ refreshToken: 'some-refresh' });
    const result = await resolveGitHubTokenForSandbox({ userId, db: fakeDb });
    expect(result).toBeNull();
  });
});
