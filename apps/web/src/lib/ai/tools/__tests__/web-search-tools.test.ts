import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies
vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    ai: {
      child: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      })),
    },
  },
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id) => `***${id?.slice(-4) || ''}`),
}));

vi.mock('../../core', () => ({
  getDefaultPageSpaceSettings: vi.fn(),
  getUserGLMSettings: vi.fn(),
}));

import { webSearchTools } from '../web-search-tools';
import { getDefaultPageSpaceSettings, getUserGLMSettings } from '../../core';
import type { ToolExecutionContext } from '../../core';

const mockGetDefaultPageSpaceSettings = vi.mocked(getDefaultPageSpaceSettings);
const mockGetUserGLMSettings = vi.mocked(getUserGLMSettings);

describe('web-search-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock global fetch
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('web_search', () => {
    it('has correct tool definition', () => {
      expect(webSearchTools.web_search).toBeDefined();
      expect(webSearchTools.web_search.description).toContain('Search the web');
    });

    it('requires user authentication', async () => {
      const context = { experimental_context: {} };

      await expect(
        webSearchTools.web_search.execute({ query: 'test search' }, context)
      ).rejects.toThrow('User authentication required for web search');
    });

    it('returns error when no API key configured', async () => {
      mockGetDefaultPageSpaceSettings.mockResolvedValue(null);
      mockGetUserGLMSettings.mockResolvedValue(null);

      const context = {
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await webSearchTools.web_search.execute(
        { query: 'test search' },
        context
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('GLM API key not configured');
    });

    it('uses default PageSpace GLM key when available', async () => {
      mockGetDefaultPageSpaceSettings.mockResolvedValue({
        provider: 'glm',
        apiKey: 'default-glm-key',
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({
          created: Date.now() / 1000,
          id: 'search-123',
          request_id: 'req-123',
          search_result: [
            {
              title: 'Test Result',
              link: 'https://example.com',
              content: 'This is a test result',
              media: 'example.com',
              icon: 'https://example.com/icon.png',
              refer: '[ref_1]',
            },
          ],
        }),
      });

      const context = {
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await webSearchTools.web_search.execute(
        { query: 'test search' },
        context
      );

      expect(result.success).toBe(true);
      expect(result.resultsCount).toBe(1);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.z.ai/api/paas/v4/web_search',
        expect.objectContaining({
          method: 'POST',
          headers: {
            Authorization: 'Bearer default-glm-key',
            'Content-Type': 'application/json',
          },
        })
      );
    });

    it('falls back to user GLM key when no default', async () => {
      mockGetDefaultPageSpaceSettings.mockResolvedValue(null);
      mockGetUserGLMSettings.mockResolvedValue({
        apiKey: 'user-glm-key',
        isConfigured: true,
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({
          created: Date.now() / 1000,
          id: 'search-123',
          request_id: 'req-123',
          search_result: [],
        }),
      });

      const context = {
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await webSearchTools.web_search.execute(
        { query: 'test search' },
        context
      );

      expect(result.success).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.z.ai/api/paas/v4/web_search',
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer user-glm-key',
            'Content-Type': 'application/json',
          },
        })
      );
    });

    it('handles API error response', async () => {
      mockGetDefaultPageSpaceSettings.mockResolvedValue({
        provider: 'glm',
        apiKey: 'test-key',
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'Invalid API key',
      });

      const context = {
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await webSearchTools.web_search.execute(
        { query: 'test search' },
        context
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('401 Unauthorized');
    });

    it('applies domain filter when specified', async () => {
      mockGetDefaultPageSpaceSettings.mockResolvedValue({
        provider: 'glm',
        apiKey: 'test-key',
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({
          created: Date.now() / 1000,
          id: 'search-123',
          request_id: 'req-123',
          search_result: [],
        }),
      });

      const context = {
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await webSearchTools.web_search.execute(
        { query: 'react hooks', domainFilter: 'react.dev' },
        context
      );

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"search_domain_filter":"react.dev"'),
        })
      );
    });

    it('applies recency filter when specified', async () => {
      mockGetDefaultPageSpaceSettings.mockResolvedValue({
        provider: 'glm',
        apiKey: 'test-key',
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({
          created: Date.now() / 1000,
          id: 'search-123',
          request_id: 'req-123',
          search_result: [],
        }),
      });

      const context = {
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await webSearchTools.web_search.execute(
        { query: 'latest news', recencyFilter: 'oneWeek' },
        context
      );

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"search_recency_filter":"oneWeek"'),
        })
      );
    });

    it('respects count parameter', async () => {
      mockGetDefaultPageSpaceSettings.mockResolvedValue({
        provider: 'glm',
        apiKey: 'test-key',
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({
          created: Date.now() / 1000,
          id: 'search-123',
          request_id: 'req-123',
          search_result: [],
        }),
      });

      const context = {
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await webSearchTools.web_search.execute(
        { query: 'test', count: 25 },
        context
      );

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"count":25'),
        })
      );
    });

    it('formats search results correctly', async () => {
      mockGetDefaultPageSpaceSettings.mockResolvedValue({
        provider: 'glm',
        apiKey: 'test-key',
      });

      const mockResults = [
        {
          title: 'First Result',
          link: 'https://example1.com',
          content: 'Summary of first result',
          media: 'example1.com',
          icon: 'https://example1.com/icon.png',
          publish_date: '2025-01-15',
          refer: '[ref_1]',
        },
        {
          title: 'Second Result',
          link: 'https://example2.com',
          content: 'Summary of second result',
          media: 'example2.com',
          icon: 'https://example2.com/icon.png',
          refer: '[ref_2]',
        },
      ];

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({
          created: Date.now() / 1000,
          id: 'search-123',
          request_id: 'req-123',
          search_result: mockResults,
        }),
      });

      const context = {
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await webSearchTools.web_search.execute(
        { query: 'test' },
        context
      );

      expect(result.success).toBe(true);
      expect(result.resultsCount).toBe(2);
      expect(result.results[0].position).toBe(1);
      expect(result.results[0].title).toBe('First Result');
      expect(result.results[0].url).toBe('https://example1.com');
      expect(result.results[0].publishDate).toBe('2025-01-15');
      expect(result.results[1].position).toBe(2);
      expect(result.results[1].publishDate).toBe('Unknown');
    });
  });
});
