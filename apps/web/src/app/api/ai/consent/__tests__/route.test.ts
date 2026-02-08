import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Mock auth
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

// Mock repository
vi.mock('@/lib/repositories/ai-consent-repository', () => ({
  aiConsentRepository: {
    getConsents: vi.fn(),
    grantConsent: vi.fn(),
    revokeConsent: vi.fn(),
    hasConsent: vi.fn(),
  },
}));

// Mock logger
vi.mock('@pagespace/lib/server', () => ({
  loggers: { ai: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } },
}));

// Mock provider config
vi.mock('@/lib/ai/core/ai-providers-config', () => ({
  requiresConsent: vi.fn(),
}));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { aiConsentRepository } from '@/lib/repositories/ai-consent-repository';
import { requiresConsent } from '@/lib/ai/core/ai-providers-config';
import { GET, POST, DELETE } from '../route';

const mockUserId = 'user-123';
const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

describe('AI Consent API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/ai/consent', () => {
    it('returns consent records for authenticated user', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
      vi.mocked(isAuthError).mockReturnValue(false);
      vi.mocked(aiConsentRepository.getConsents).mockResolvedValue([
        { id: '1', provider: 'openai', consentedAt: new Date(), revokedAt: null },
      ]);

      const request = new Request('http://localhost/api/ai/consent');
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.consents).toHaveLength(1);
      expect(data.consents[0].provider).toBe('openai');
    });

    it('returns 401 for unauthenticated request', async () => {
      const authError = mockAuthError(401);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(authError);
      vi.mocked(isAuthError).mockReturnValue(true);

      const request = new Request('http://localhost/api/ai/consent');
      const response = await GET(request);
      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/ai/consent', () => {
    it('grants consent for a cloud provider', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
      vi.mocked(isAuthError).mockReturnValue(false);
      vi.mocked(requiresConsent).mockReturnValue(true);
      vi.mocked(aiConsentRepository.grantConsent).mockResolvedValue();

      const request = new Request('http://localhost/api/ai/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'openai' }),
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.success).toBe(true);
      expect(aiConsentRepository.grantConsent).toHaveBeenCalledWith(mockUserId, 'openai');
    });

    it('returns 400 for exempt provider', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
      vi.mocked(isAuthError).mockReturnValue(false);
      vi.mocked(requiresConsent).mockReturnValue(false);

      const request = new Request('http://localhost/api/ai/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'pagespace' }),
      });
      const response = await POST(request);
      expect(response.status).toBe(400);
    });

    it('returns 400 without provider', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
      vi.mocked(isAuthError).mockReturnValue(false);

      const request = new Request('http://localhost/api/ai/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const response = await POST(request);
      expect(response.status).toBe(400);
    });
  });

  describe('DELETE /api/ai/consent', () => {
    it('revokes consent for a provider', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
      vi.mocked(isAuthError).mockReturnValue(false);
      vi.mocked(aiConsentRepository.revokeConsent).mockResolvedValue();

      const request = new Request('http://localhost/api/ai/consent', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'openai' }),
      });
      const response = await DELETE(request);
      expect(response.status).toBe(204);
      expect(aiConsentRepository.revokeConsent).toHaveBeenCalledWith(mockUserId, 'openai');
    });
  });
});
