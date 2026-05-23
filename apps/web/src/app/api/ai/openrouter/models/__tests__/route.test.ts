import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '../route';
import { filterFreeModels } from '../filter-utils';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    ai: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

vi.mock('@/lib/auth', () => ({
  authenticateSessionRequest: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@/lib/ai/core/ai-utils', () => ({
  getManagedProviderKey: vi.fn(),
}));

import { loggers } from '@pagespace/lib/logging/logger-config';
import { authenticateSessionRequest, isAuthError } from '@/lib/auth';
import { getManagedProviderKey } from '@/lib/ai/core/ai-utils';

const mockWebAuth = (userId: string, tokenVersion = 0): SessionAuthResult => ({
  userId,
  tokenVersion,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const TOOL_PARAMS = ['tools', 'tool_choice', 'temperature'];

const makeFreeModel = (id: string, name: string) => ({
  id,
  name,
  pricing: { prompt: '0', completion: '0' },
  supported_parameters: TOOL_PARAMS,
});

const makePaidModel = (id: string, name: string) => ({
  id,
  name,
  pricing: { prompt: '0.000001', completion: '0.000002' },
  supported_parameters: TOOL_PARAMS,
});

const makeNonToolModel = (id: string, name: string) => ({
  id,
  name,
  pricing: { prompt: '0', completion: '0' },
  // no supported_parameters — model cannot use tools
});

// ── Pure function tests ───────────────────────────────────────────────────────

describe('filterFreeModels', () => {
  it('should keep models with :free suffix and zero prompt pricing', () => {
    const models = [makeFreeModel('meta-llama/llama-3.3-70b-instruct:free', 'Llama 3.3 70B')];
    expect(filterFreeModels(models)).toEqual({
      'meta-llama/llama-3.3-70b-instruct:free': 'Llama 3.3 70B',
    });
  });

  it('should exclude models without :free suffix even if pricing is zero', () => {
    const models = [makeFreeModel('meta-llama/llama-3.3-70b-instruct', 'Llama 3.3 70B')];
    expect(filterFreeModels(models)).toEqual({});
  });

  it('should exclude :free-suffixed models with non-zero prompt pricing', () => {
    const models = [makePaidModel('some/model:free', 'Paid Free Model')];
    expect(filterFreeModels(models)).toEqual({});
  });

  it('should exclude models with no pricing field', () => {
    const models = [{ id: 'some/model:free', name: 'No Pricing' }];
    expect(filterFreeModels(models)).toEqual({});
  });

  it('should handle a mixed list and return only qualifying models', () => {
    const models = [
      makeFreeModel('qwen/qwen3-coder:free', 'Qwen3 Coder'),
      makePaidModel('openai/gpt-4o', 'GPT-4o'),
      makeFreeModel('google/gemma-4-31b-it:free', 'Gemma 4 31B'),
      makePaidModel('fake/model:free', 'Fake Paid Free'),
      { id: 'no-pricing:free', name: 'No Pricing' },
    ];
    expect(filterFreeModels(models)).toEqual({
      'qwen/qwen3-coder:free': 'Qwen3 Coder',
      'google/gemma-4-31b-it:free': 'Gemma 4 31B',
    });
  });

  it('should return empty object for empty input', () => {
    expect(filterFreeModels([])).toEqual({});
  });

  it('should exclude free models with no supported_parameters', () => {
    const models = [makeNonToolModel('some/model:free', 'No Params')];
    expect(filterFreeModels(models)).toEqual({});
  });

  it('should exclude free models that have tools but not tool_choice', () => {
    const models = [{ id: 'some/model:free', name: 'Partial Tools', pricing: { prompt: '0' }, supported_parameters: ['tools', 'temperature'] }];
    expect(filterFreeModels(models)).toEqual({});
  });

  it('should exclude free models that have tool_choice but not tools', () => {
    const models = [{ id: 'some/model:free', name: 'Partial Tools', pricing: { prompt: '0' }, supported_parameters: ['tool_choice', 'temperature'] }];
    expect(filterFreeModels(models)).toEqual({});
  });

  it('should include free models that have both tools and tool_choice', () => {
    const models = [makeFreeModel('qwen/qwen3-coder:free', 'Qwen3 Coder')];
    expect(filterFreeModels(models)).toEqual({ 'qwen/qwen3-coder:free': 'Qwen3 Coder' });
  });

  it('should drop non-tool-capable models from a mixed list', () => {
    const models = [
      makeFreeModel('qwen/qwen3-coder:free', 'Qwen3 Coder'),
      makeNonToolModel('google/gemma-3n-e4b-it:free', 'Gemma 3n'),
      makeFreeModel('meta-llama/llama-3.3-70b-instruct:free', 'Llama 3.3 70B'),
    ];
    expect(filterFreeModels(models)).toEqual({
      'qwen/qwen3-coder:free': 'Qwen3 Coder',
      'meta-llama/llama-3.3-70b-instruct:free': 'Llama 3.3 70B',
    });
  });
});

// ── Route handler tests ───────────────────────────────────────────────────────

describe('GET /api/ai/openrouter/models', () => {
  const mockUserId = 'user_123';
  const mockApiKey = 'sk-or-test-key';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateSessionRequest).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(getManagedProviderKey).mockReturnValue(null);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateSessionRequest).mockResolvedValue(mockAuthError(401));

      const response = await GET(new Request('https://example.com/api/ai/openrouter/models'));
      expect(response.status).toBe(401);
    });
  });

  describe('configuration validation', () => {
    it('should return 503 when OpenRouter is not configured', async () => {
      vi.mocked(getManagedProviderKey).mockReturnValue(null);

      const response = await GET(new Request('https://example.com/api/ai/openrouter/models'));
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not configured');
      expect(body.models).toEqual({});
    });
  });

  describe('successful model fetch', () => {
    it('should return only free models from OpenRouter', async () => {
      vi.mocked(getManagedProviderKey).mockReturnValue({ apiKey: mockApiKey });

      const mockData = {
        data: [
          makeFreeModel('qwen/qwen3-coder:free', 'Qwen3 Coder'),
          makePaidModel('openai/gpt-4o', 'GPT-4o'),
          makeFreeModel('google/gemma-4-31b-it:free', 'Gemma 4 31B'),
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockData),
      });

      const response = await GET(new Request('https://example.com/api/ai/openrouter/models'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.models).toEqual({
        'qwen/qwen3-coder:free': 'Qwen3 Coder',
        'google/gemma-4-31b-it:free': 'Gemma 4 31B',
      });
      expect(body.modelCount).toBe(2);
    });

    it('should call the OpenRouter models endpoint with the managed API key', async () => {
      vi.mocked(getManagedProviderKey).mockReturnValue({ apiKey: mockApiKey });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });

      await GET(new Request('https://example.com/api/ai/openrouter/models'));

      expect(global.fetch).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/models',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: `Bearer ${mockApiKey}` }),
        })
      );
    });

    it('should return empty models when all fetched models are paid', async () => {
      vi.mocked(getManagedProviderKey).mockReturnValue({ apiKey: mockApiKey });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [makePaidModel('openai/gpt-4o', 'GPT-4o')] }),
      });

      const response = await GET(new Request('https://example.com/api/ai/openrouter/models'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.models).toEqual({});
      expect(body.modelCount).toBe(0);
    });

    it('should log successful fetch', async () => {
      vi.mocked(getManagedProviderKey).mockReturnValue({ apiKey: mockApiKey });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [makeFreeModel('qwen/qwen3-coder:free', 'Qwen3 Coder')] }),
      });

      await GET(new Request('https://example.com/api/ai/openrouter/models'));

      expect(loggers.ai.info).toHaveBeenCalledWith(
        'Successfully fetched OpenRouter free models',
        expect.objectContaining({ userId: mockUserId, modelCount: 1 })
      );
    });

    it('should handle missing data array in response', async () => {
      vi.mocked(getManagedProviderKey).mockReturnValue({ apiKey: mockApiKey });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const response = await GET(new Request('https://example.com/api/ai/openrouter/models'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.models).toEqual({});
    });
  });

  describe('fetch failures', () => {
    it('should return 200 with empty models when OpenRouter is unreachable', async () => {
      vi.mocked(getManagedProviderKey).mockReturnValue({ apiKey: mockApiKey });
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const response = await GET(new Request('https://example.com/api/ai/openrouter/models'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Could not fetch OpenRouter models');
      expect(body.models).toEqual({});
    });

    it('should return 200 with empty models when OpenRouter returns non-OK status', async () => {
      vi.mocked(getManagedProviderKey).mockReturnValue({ apiKey: mockApiKey });
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

      const response = await GET(new Request('https://example.com/api/ai/openrouter/models'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(false);
      expect(body.models).toEqual({});
    });

    it('should log fetch errors', async () => {
      vi.mocked(getManagedProviderKey).mockReturnValue({ apiKey: mockApiKey });
      const error = new Error('Timeout');
      global.fetch = vi.fn().mockRejectedValue(error);

      await GET(new Request('https://example.com/api/ai/openrouter/models'));

      expect(loggers.ai.error).toHaveBeenCalledWith(
        'Failed to fetch models from OpenRouter',
        error,
        expect.objectContaining({ userId: mockUserId })
      );
    });
  });

  describe('unexpected errors', () => {
    it('should return 500 on unexpected errors', async () => {
      vi.mocked(getManagedProviderKey).mockImplementationOnce(() => { throw new Error('DB error'); });

      const response = await GET(new Request('https://example.com/api/ai/openrouter/models'));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Failed to fetch OpenRouter models');
      expect(body.models).toEqual({});
      expect(loggers.ai.error).toHaveBeenCalledWith(
        'OpenRouter models fetch error',
        expect.objectContaining({ message: 'DB error' })
      );
    });
  });
});
