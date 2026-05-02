/**
 * Contract tests for GET/POST/PATCH/DELETE /api/ai/settings.
 *
 * Post-BYOK: GET reports deployment-level provider availability,
 * POST/DELETE return 410 Gone, PATCH updates the user's selected
 * provider/model and rejects unavailable providers with 503.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';

vi.mock('@/lib/repositories/ai-settings-repository', () => ({
  aiSettingsRepository: {
    getUserSettings: vi.fn(),
    updateProviderSettings: vi.fn(),
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => {
  const child = vi.fn(() => ({
    info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() })),
  }));
  return {
    loggers: {
      ai: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child },
    },
    logger: { child },
  };
});

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/deployment-mode', () => ({
  isOnPrem: vi.fn(() => false),
}));

vi.mock('@/lib/subscription/rate-limit-middleware', () => ({
  requiresProSubscription: vi.fn(() => false),
}));

import { GET, POST, PATCH, DELETE } from '../route';
import { aiSettingsRepository } from '@/lib/repositories/ai-settings-repository';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { requiresProSubscription } from '@/lib/subscription/rate-limit-middleware';

const ENV_KEYS = [
  'ANTHROPIC_DEFAULT_API_KEY',
  'OPENAI_DEFAULT_API_KEY',
  'GOOGLE_AI_DEFAULT_API_KEY',
  'XAI_DEFAULT_API_KEY',
  'OPENROUTER_DEFAULT_API_KEY',
  'GLM_CODER_DEFAULT_API_KEY',
  'MINIMAX_DEFAULT_API_KEY',
  'OLLAMA_BASE_URL',
  'LMSTUDIO_BASE_URL',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'GLM_DEFAULT_API_KEY',
] as const;

const mockUserId = 'user_123';

const mockSession = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

function makeRequest(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: unknown): Request {
  return new Request('http://localhost:3000/api/ai/settings', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('AI settings route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSession(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(isOnPrem).mockReturnValue(false);
    vi.mocked(requiresProSubscription).mockReturnValue(false);
    vi.mocked(aiSettingsRepository.getUserSettings).mockResolvedValue({
      id: mockUserId,
      currentAiProvider: 'pagespace',
      currentAiModel: 'glm-4.7',
      subscriptionTier: 'pro',
    });
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  describe('GET', () => {
    it('reports providers as unavailable when no env keys are set', async () => {
      const response = await GET(makeRequest('GET'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.providers.anthropic.isAvailable).toBe(false);
      expect(body.providers.pagespace.isAvailable).toBe(false);
      expect(body.providers.openai.isAvailable).toBe(false);
      expect(body.isAnyProviderConfigured).toBe(false);
    });

    it('reports isAnyProviderConfigured true when at least one provider has an env key', async () => {
      process.env.ANTHROPIC_DEFAULT_API_KEY = 'a';

      const response = await GET(makeRequest('GET'));
      const body = await response.json();

      expect(body.isAnyProviderConfigured).toBe(true);
    });

    it('marks pagespace available when GLM_DEFAULT_API_KEY is set', async () => {
      process.env.GLM_DEFAULT_API_KEY = 'glm-managed';

      const response = await GET(makeRequest('GET'));
      const body = await response.json();

      expect(body.providers.pagespace.isAvailable).toBe(true);
      expect(body.pageSpaceBackend).toBe('glm');
    });

    it('marks each cloud provider available when its env var is set', async () => {
      process.env.ANTHROPIC_DEFAULT_API_KEY = 'a';
      process.env.OPENAI_DEFAULT_API_KEY = 'b';
      process.env.GOOGLE_AI_DEFAULT_API_KEY = 'c';
      process.env.XAI_DEFAULT_API_KEY = 'd';
      process.env.OPENROUTER_DEFAULT_API_KEY = 'e';

      const response = await GET(makeRequest('GET'));
      const body = await response.json();

      expect(body.providers.anthropic.isAvailable).toBe(true);
      expect(body.providers.openai.isAvailable).toBe(true);
      expect(body.providers.google.isAvailable).toBe(true);
      expect(body.providers.xai.isAvailable).toBe(true);
      expect(body.providers.openrouter.isAvailable).toBe(true);
      expect(body.providers.openrouter_free.isAvailable).toBe(true);
    });

    it('marks ollama available only when OLLAMA_BASE_URL is set', async () => {
      const before = await GET(makeRequest('GET'));
      expect((await before.json()).providers.ollama.isAvailable).toBe(false);

      process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
      const after = await GET(makeRequest('GET'));
      expect((await after.json()).providers.ollama.isAvailable).toBe(true);
    });

    it('hides cloud providers in onprem mode regardless of env state', async () => {
      vi.mocked(isOnPrem).mockReturnValue(true);
      process.env.ANTHROPIC_DEFAULT_API_KEY = 'set';
      process.env.OLLAMA_BASE_URL = 'http://localhost:11434';

      const response = await GET(makeRequest('GET'));
      const body = await response.json();

      expect(body.providers.anthropic.isAvailable).toBe(false);
      expect(body.providers.openai.isAvailable).toBe(false);
      expect(body.providers.ollama.isAvailable).toBe(true);
    });

    it('returns the user current selection and tier', async () => {
      vi.mocked(aiSettingsRepository.getUserSettings).mockResolvedValue({
        id: mockUserId,
        currentAiProvider: 'anthropic',
        currentAiModel: 'claude-sonnet-4-6',
        subscriptionTier: 'business',
      });

      const response = await GET(makeRequest('GET'));
      const body = await response.json();

      expect(body.currentProvider).toBe('anthropic');
      expect(body.currentModel).toBe('claude-sonnet-4-6');
      expect(body.userSubscriptionTier).toBe('business');
    });

    it('returns auth error when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      const errorResponse = { error: new Response('Unauthorized', { status: 401 }) };
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(errorResponse as never);

      const response = await GET(makeRequest('GET'));
      expect(response.status).toBe(401);
    });
  });

  describe('POST', () => {
    it('returns 410 Gone with retirement message', async () => {
      const response = await POST();
      const body = await response.json();

      expect(response.status).toBe(410);
      expect(body.error).toContain('retired');
    });
  });

  describe('DELETE', () => {
    it('returns 410 Gone with retirement message', async () => {
      const response = await DELETE();
      const body = await response.json();

      expect(response.status).toBe(410);
      expect(body.error).toContain('retired');
    });
  });

  describe('PATCH', () => {
    it('updates the user selection when provider is available', async () => {
      process.env.ANTHROPIC_DEFAULT_API_KEY = 'a';

      const response = await PATCH(makeRequest('PATCH', {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(aiSettingsRepository.updateProviderSettings).toHaveBeenCalledWith(mockUserId, {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      });
    });

    it('returns 503 when the requested provider is not configured', async () => {
      const response = await PATCH(makeRequest('PATCH', {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      }));
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body.error).toContain('not configured');
      expect(aiSettingsRepository.updateProviderSettings).not.toHaveBeenCalled();
    });

    it('returns 400 for an unknown provider', async () => {
      const response = await PATCH(makeRequest('PATCH', {
        provider: 'totally-not-real',
        model: 'x',
      }));

      expect(response.status).toBe(400);
    });

    it('returns 400 when model is missing for a non-local provider', async () => {
      process.env.ANTHROPIC_DEFAULT_API_KEY = 'a';

      const response = await PATCH(makeRequest('PATCH', { provider: 'anthropic' }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Model is required');
    });

    it('allows local providers without a model', async () => {
      process.env.OLLAMA_BASE_URL = 'http://localhost:11434';

      const response = await PATCH(makeRequest('PATCH', { provider: 'ollama' }));

      expect(response.status).toBe(200);
    });

    it('returns 403 when pro-tier model selected on free subscription', async () => {
      process.env.GLM_DEFAULT_API_KEY = 'g';
      vi.mocked(requiresProSubscription).mockReturnValue(true);

      const response = await PATCH(makeRequest('PATCH', {
        provider: 'pagespace',
        model: 'glm-5',
      }));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.upgradeUrl).toBe('/settings/billing');
    });
  });
});
