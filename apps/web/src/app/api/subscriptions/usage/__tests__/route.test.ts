import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult } from '@/lib/auth';

// Mock usage service - use vi.hoisted to ensure mock is available before vi.mock
const { mockGetUserUsageSummary } = vi.hoisted(() => ({
  mockGetUserUsageSummary: vi.fn(),
}));
vi.mock('@/lib/subscription/usage-service', () => ({
  getUserUsageSummary: mockGetUserUsageSummary,
}));

// Mock auth
vi.mock('@/lib/auth/auth-helpers', () => ({
  requireAuth: vi.fn(),
  isAuthError: vi.fn(),
}));

// Mock @pagespace/lib/server
vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { warn: vi.fn() },
  },
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

// Import after mocks
import { GET } from '../route';
import { requireAuth, isAuthError } from '@/lib/auth/auth-helpers';
import { auditRequest } from '@pagespace/lib/server';

// Helper to create mock SessionAuthResult
const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  adminRoleVersion: 0,
  role: 'user',
});

describe('GET /api/subscriptions/usage', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(requireAuth).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    mockGetUserUsageSummary.mockResolvedValue({
      aiCredits: { used: 10, limit: 100 },
      storage: { used: 1024, limit: 524288000 },
    });
  });

  it('should return usage summary', async () => {
    const request = new Request('https://example.com/api/subscriptions/usage', {
      method: 'GET',
    }) as unknown as import('next/server').NextRequest;

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetUserUsageSummary).toHaveBeenCalledWith(mockUserId);
    expect(body.aiCredits).toBeDefined();
  });

  it('should return auth error when not authenticated', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(requireAuth).mockResolvedValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    );

    const request = new Request('https://example.com/api/subscriptions/usage', {
      method: 'GET',
    }) as unknown as import('next/server').NextRequest;

    const response = await GET(request);

    expect(response.status).toBe(401);
  });

  it('should log audit event on GET usage', async () => {
    const request = new Request('https://example.com/api/subscriptions/usage', {
      method: 'GET',
    }) as unknown as import('next/server').NextRequest;

    await GET(request);

    expect(auditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.read', userId: mockUserId, resourceType: 'subscription_usage', resourceId: 'self' })
    );
  });

  it('should not include userId in audit details (GDPR: details field is in hash chain)', async () => {
    const request = new Request('https://example.com/api/subscriptions/usage', {
      method: 'GET',
    }) as unknown as import('next/server').NextRequest;

    await GET(request);

    const eventArg = vi.mocked(auditRequest).mock.calls[0]?.[1];
    expect(eventArg?.details).toBeUndefined();
  });
});
