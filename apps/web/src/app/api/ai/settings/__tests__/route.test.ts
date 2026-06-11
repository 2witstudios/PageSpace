/**
 * Contract tests for GET/POST/PATCH/DELETE /api/ai/settings.
 *
 * Post-BYOK + OpenRouter consolidation: GET reports deployment-level provider
 * availability for every vendor (all OpenRouter-backed in cloud), POST/DELETE
 * return 410 Gone, PATCH updates the user's selected provider/model and rejects
 * unavailable providers with 503 and non-allowlist models for free users with 403.
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
  createAdminRestrictedResponse: vi.fn(() =>
    new Response(
      JSON.stringify({ error: 'Provider restricted', message: 'This provider is restricted to administrators.' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    )
  ),
}));

import { GET, POST, PATCH, DELETE } from '../route';
import { aiSettingsRepository } from '@/lib/repositories/ai-settings-repository';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { requiresProSubscription, createAdminRestrictedResponse } from '@/lib/subscription/rate-limit-middleware';

const ENV_KEYS = [
  'OPENROUTER_DEFAULT_API_KEY',
  'OPENAI_DEFAULT_API_KEY',
  'OLLAMA_BASE_URL',
  'LMSTUDIO_BASE_URL',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'GLM_CODER_DEFAULT_API_KEY',
] as const;

const mockUserId = 'user_123';

const mockSession = (userId: string, role: 'user' | 'admin' = 'user'): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role,
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
      currentAiProvider: 'openai',
      currentAiModel: 'openai/gpt-5.3-chat',
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
      expect(body.providers.openai.isAvailable).toBe(false);
      expect(body.providers.google.isAvailable).toBe(false);
      expect(body.isAnyProviderConfigured).toBe(false);
    });

    it('reports all cloud vendors available once OPENROUTER_DEFAULT_API_KEY is set', async () => {
      process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';

      const response = await GET(makeRequest('GET'));
      const body = await response.json();

      // Every cloud vendor is OpenRouter-backed, so the single key lights them all up.
      expect(body.providers.openai.isAvailable).toBe(true);
      expect(body.providers.anthropic.isAvailable).toBe(true);
      expect(body.providers.google.isAvailable).toBe(true);
      expect(body.providers.xai.isAvailable).toBe(true);
      expect(body.providers.deepseek.isAvailable).toBe(true);
      expect(body.isAnyProviderConfigured).toBe(true);
    });

    it('does not return the retired pageSpaceBackend field', async () => {
      process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';

      const response = await GET(makeRequest('GET'));
      const body = await response.json();

      expect(body.pageSpaceBackend).toBeUndefined();
    });

    it('exposes all OpenRouter-backed vendor providers in cloud mode when configured', async () => {
      process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';

      const response = await GET(makeRequest('GET'));
      const body = await response.json();

      // Cloud mode: every OpenRouter-backed vendor shows up once the key is set.
      // GLM (direct/admin-only) has its own separate key gate.
      expect(body.providers.anthropic.isAvailable).toBe(true);
      expect(body.providers.openai.isAvailable).toBe(true);
      expect(body.providers.google.isAvailable).toBe(true);
      expect(body.providers.xai.isAvailable).toBe(true);
      expect(body.providers.mistral.isAvailable).toBe(true);
    });

    it('returns isAdmin: false for regular users', async () => {
      const response = await GET(makeRequest('GET'));
      expect((await response.json()).isAdmin).toBe(false);
    });

    it('returns isAdmin: true for admin users', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSession(mockUserId, 'admin'));

      const response = await GET(makeRequest('GET'));
      expect((await response.json()).isAdmin).toBe(true);
    });

    it('reports glm unavailable when GLM_CODER_DEFAULT_API_KEY is unset', async () => {
      process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';
      const response = await GET(makeRequest('GET'));
      expect((await response.json()).providers.glm.isAvailable).toBe(false);
    });

    it('reports glm available when GLM_CODER_DEFAULT_API_KEY is set', async () => {
      process.env.GLM_CODER_DEFAULT_API_KEY = 'glm-key';
      const response = await GET(makeRequest('GET'));
      expect((await response.json()).providers.glm.isAvailable).toBe(true);
    });

    it('reports the public zai provider available when the OpenRouter key is set', async () => {
      // zai is OpenRouter-backed; without it in ALL_PROVIDER_NAMES the availability
      // map omits it and the picker/agent-config show "Setup Required".
      process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';
      const response = await GET(makeRequest('GET'));
      expect((await response.json()).providers.zai.isAvailable).toBe(true);
    });

    it('reports the public zai provider unavailable when the OpenRouter key is unset', async () => {
      delete process.env.OPENROUTER_DEFAULT_API_KEY;
      const response = await GET(makeRequest('GET'));
      expect((await response.json()).providers.zai.isAvailable).toBe(false);
    });

    it('does not expose a paid `openrouter` or `pagespace` provider key', async () => {
      process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';

      const response = await GET(makeRequest('GET'));
      const body = await response.json();

      // The removed virtual providers no longer appear in the availability map.
      expect(body.providers.openrouter).toBeUndefined();
      expect(body.providers.openrouter_free).toBeUndefined();
      expect(body.providers.pagespace).toBeUndefined();
    });

    it('reports ollama unavailable when OLLAMA_BASE_URL is unset', async () => {
      process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';
      const response = await GET(makeRequest('GET'));
      expect((await response.json()).providers.ollama.isAvailable).toBe(false);
    });

    it('exposes configured local providers in onprem mode without masking', async () => {
      vi.mocked(isOnPrem).mockReturnValue(true);
      process.env.OPENROUTER_DEFAULT_API_KEY = 'set';
      process.env.OLLAMA_BASE_URL = 'http://localhost:11434';

      const response = await GET(makeRequest('GET'));
      const body = await response.json();

      // On-prem: cloud providers still hidden (not in ONPREM_ALLOWED_PROVIDERS)
      expect(body.providers.anthropic.isAvailable).toBe(false);
      expect(body.providers.openai.isAvailable).toBe(false);
      // On-prem: local providers are NOT masked — ollama shows up
      expect(body.providers.ollama.isAvailable).toBe(true);
    });

    it('returns the user current selection and tier', async () => {
      vi.mocked(aiSettingsRepository.getUserSettings).mockResolvedValue({
        id: mockUserId,
        currentAiProvider: 'anthropic',
        currentAiModel: 'anthropic/claude-sonnet-4.6',
        subscriptionTier: 'business',
      });

      const response = await GET(makeRequest('GET'));
      const body = await response.json();

      expect(body.currentProvider).toBe('anthropic');
      expect(body.currentModel).toBe('anthropic/claude-sonnet-4.6');
      expect(body.userSubscriptionTier).toBe('business');
    });

    it('falls back to the default provider/model when the user has no selection', async () => {
      vi.mocked(aiSettingsRepository.getUserSettings).mockResolvedValue({
        id: mockUserId,
        currentAiProvider: null,
        currentAiModel: null,
        subscriptionTier: null,
      });

      const response = await GET(makeRequest('GET'));
      const body = await response.json();

      expect(body.currentProvider).toBe('openai');
      expect(body.currentModel).toBe('openai/gpt-5.3-chat');
      expect(body.userSubscriptionTier).toBe('free');
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
    it('updates the user selection for a configured cloud vendor', async () => {
      process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';

      const response = await PATCH(makeRequest('PATCH', {
        provider: 'openai',
        model: 'openai/gpt-5.3-chat',
      }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(aiSettingsRepository.updateProviderSettings).toHaveBeenCalledWith(mockUserId, {
        provider: 'openai',
        model: 'openai/gpt-5.3-chat',
      });
    });

    it('allows selecting another configured vendor (anthropic) on a paid tier', async () => {
      process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';

      const response = await PATCH(makeRequest('PATCH', {
        provider: 'anthropic',
        model: 'anthropic/claude-opus-4.8',
      }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(aiSettingsRepository.updateProviderSettings).toHaveBeenCalledWith(mockUserId, {
        provider: 'anthropic',
        model: 'anthropic/claude-opus-4.8',
      });
    });

    it('passes isAdmin=true to the subscription gate for admin callers', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSession(mockUserId, 'admin'));
      process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';
      vi.mocked(aiSettingsRepository.getUserSettings).mockResolvedValue({
        id: mockUserId,
        currentAiProvider: 'openai',
        currentAiModel: 'openai/gpt-5.3-chat',
        subscriptionTier: 'free',
      });

      const response = await PATCH(makeRequest('PATCH', {
        provider: 'anthropic',
        model: 'anthropic/claude-opus-4.8',
      }));

      expect(response.status).toBe(200);
      // Admins bypass the subscription gate — it must be told the caller is an admin.
      expect(requiresProSubscription).toHaveBeenCalledWith('anthropic', 'anthropic/claude-opus-4.8', 'free', true);
    });

    it('returns 503 for a cloud vendor when OPENROUTER_DEFAULT_API_KEY is not configured', async () => {
      const response = await PATCH(makeRequest('PATCH', {
        provider: 'anthropic',
        model: 'anthropic/claude-sonnet-4.6',
      }));
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body.error).toContain('not configured');
      expect(aiSettingsRepository.updateProviderSettings).not.toHaveBeenCalled();
    });

    it('allows local providers in onprem mode when configured', async () => {
      vi.mocked(isOnPrem).mockReturnValue(true);
      process.env.OLLAMA_BASE_URL = 'http://localhost:11434';

      const response = await PATCH(makeRequest('PATCH', { provider: 'ollama' }));

      expect(response.status).toBe(200);
    });

    it('returns 400 for an unknown provider', async () => {
      const response = await PATCH(makeRequest('PATCH', {
        provider: 'totally-not-real',
        model: 'x',
      }));

      expect(response.status).toBe(400);
    });

    it('returns 400 when model is missing for a cloud vendor', async () => {
      process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';

      const response = await PATCH(makeRequest('PATCH', { provider: 'openai' }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Model is required');
    });

    it('returns 403 when a free user selects a non-allowlist model', async () => {
      process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';
      vi.mocked(aiSettingsRepository.getUserSettings).mockResolvedValue({
        id: mockUserId,
        currentAiProvider: 'openai',
        currentAiModel: 'openai/gpt-5.3-chat',
        subscriptionTier: 'free',
      });
      vi.mocked(requiresProSubscription).mockReturnValue(true);

      const response = await PATCH(makeRequest('PATCH', {
        provider: 'anthropic',
        model: 'anthropic/claude-opus-4.8',
      }));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.upgradeUrl).toBe('/settings/plan');
    });

    it('lets a free user select an allowlist model (default model)', async () => {
      process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';
      vi.mocked(aiSettingsRepository.getUserSettings).mockResolvedValue({
        id: mockUserId,
        currentAiProvider: 'openai',
        currentAiModel: 'openai/gpt-5.3-chat',
        subscriptionTier: 'free',
      });
      vi.mocked(requiresProSubscription).mockReturnValue(false);

      const response = await PATCH(makeRequest('PATCH', {
        provider: 'openai',
        model: 'openai/gpt-5.3-chat',
      }));

      expect(response.status).toBe(200);
    });

    it('returns 403 when a non-admin selects an admin-only provider (glm)', async () => {
      process.env.GLM_CODER_DEFAULT_API_KEY = 'glm-key';

      const response = await PATCH(makeRequest('PATCH', {
        provider: 'glm',
        model: 'glm-4.5-air',
      }));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.message).toContain('restricted to administrators');
      expect(createAdminRestrictedResponse).toHaveBeenCalled();
      expect(aiSettingsRepository.updateProviderSettings).not.toHaveBeenCalled();
    });

    it('allows an admin to select an admin-only provider (glm)', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSession(mockUserId, 'admin'));
      process.env.GLM_CODER_DEFAULT_API_KEY = 'glm-key';

      const response = await PATCH(makeRequest('PATCH', {
        provider: 'glm',
        model: 'glm-4.5-air',
      }));

      expect(response.status).toBe(200);
      expect(aiSettingsRepository.updateProviderSettings).toHaveBeenCalledWith(mockUserId, {
        provider: 'glm',
        model: 'glm-4.5-air',
      });
    });
  });
});
