import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies
const mockLookupFn = vi.hoisted(() => vi.fn());
vi.mock('dns', () => ({
  default: { promises: { lookup: mockLookupFn } },
  promises: { lookup: mockLookupFn },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
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
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id) => `***${id?.slice(-4) || ''}`),
}));

vi.mock('../../core/types', () => ({}));

import { webSearchTools } from '../web-search-tools';
import type { ToolExecutionContext } from '../../core/types';

type WebSearchResult = Exclude<
  Awaited<ReturnType<NonNullable<(typeof webSearchTools.web_search)['execute']>>>,
  AsyncIterable<unknown>
>;

const mockContext = (userId?: string) => ({
  toolCallId: '1',
  messages: [],
  experimental_context: userId ? { userId } as ToolExecutionContext : {},
});

function mockBraveResponse(results: Record<string, unknown>[] = []) {
  return {
    ok: true,
    json: async () => ({
      web: { results },
      query: { original: 'test' },
    }),
  };
}

describe('web-search-tools', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, BRAVE_API_KEY: 'test-brave-key' };
    global.fetch = vi.fn();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('web_search', () => {
    it('has correct tool definition', () => {
      expect(webSearchTools.web_search).toBeDefined();
      expect(webSearchTools.web_search.description).toContain('Search the web');
    });

    it('requires user authentication', async () => {
      await expect(
        webSearchTools.web_search!.execute!(
          { query: 'test search', count: 10, recencyFilter: 'noLimit' },
          mockContext()
        )
      ).rejects.toThrow('User authentication required for web search');
    });

    it('returns error when BRAVE_API_KEY is not set', async () => {
      delete process.env.BRAVE_API_KEY;

      const result = await webSearchTools.web_search!.execute!(
        { query: 'test search', count: 10, recencyFilter: 'noLimit' },
        mockContext('user-123')
      );

      if (!('error' in result)) throw new Error('Expected error result');
      expect(result.success).toBe(false);
      expect(result.error).toContain('BRAVE_API_KEY is not configured');
    });

    it('calls Brave Search API with correct URL and headers', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockBraveResponse([
          {
            title: 'Test Result',
            url: 'https://example.com',
            description: 'This is a test result',
            meta_url: { hostname: 'example.com', favicon: 'https://example.com/icon.png' },
          },
        ])
      );

      const result = (await webSearchTools.web_search!.execute!(
        { query: 'test search', count: 10, recencyFilter: 'noLimit' },
        mockContext('user-123')
      )) as WebSearchResult;

      if ('error' in result) throw new Error(`Expected success but got error: ${result.error}`);
      expect(result.success).toBe(true);
      expect(result.resultsCount).toBe(1);

      const [calledUrl, calledOptions] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(calledUrl).toContain('https://api.search.brave.com/res/v1/web/search?');
      expect(calledUrl).toContain('q=test+search');
      expect(calledUrl).toContain('count=10');
      expect(calledUrl).toContain('extra_snippets=true');
      expect(calledOptions.method).toBe('GET');
      expect(calledOptions.headers['X-Subscription-Token']).toBe('test-brave-key');
      expect(calledOptions.headers['Accept']).toBe('application/json');
      // No body for GET request
      expect(calledOptions.body).toBeUndefined();
    });

    it('handles API error response', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'Invalid API key',
      });

      const result = await webSearchTools.web_search!.execute!(
        { query: 'test search', count: 10, recencyFilter: 'noLimit' },
        mockContext('user-123')
      );

      if (!('error' in result)) throw new Error('Expected error result');
      expect(result.success).toBe(false);
      expect(result.error).toContain('401 Unauthorized');
    });

    it('prepends site: to query when domainFilter is specified', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBraveResponse());

      await webSearchTools.web_search!.execute!(
        { query: 'react hooks', domainFilter: 'react.dev', count: 10, recencyFilter: 'noLimit' },
        mockContext('user-123')
      );

      const [calledUrl] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const url = new URL(calledUrl);
      expect(url.searchParams.get('q')).toBe('site:react.dev react hooks');
    });

    it('maps recencyFilter to Brave freshness parameter', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBraveResponse());

      await webSearchTools.web_search!.execute!(
        { query: 'latest news', recencyFilter: 'oneWeek', count: 10 },
        mockContext('user-123')
      );

      const [calledUrl] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const url = new URL(calledUrl);
      expect(url.searchParams.get('freshness')).toBe('pw');
    });

    it('omits freshness param when recencyFilter is noLimit', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBraveResponse());

      await webSearchTools.web_search!.execute!(
        { query: 'general query', recencyFilter: 'noLimit', count: 10 },
        mockContext('user-123')
      );

      const [calledUrl] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const url = new URL(calledUrl);
      expect(url.searchParams.has('freshness')).toBe(false);
    });

    it('respects count parameter', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBraveResponse());

      await webSearchTools.web_search!.execute!(
        { query: 'test', count: 5, recencyFilter: 'noLimit' },
        mockContext('user-123')
      );

      const [calledUrl] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const url = new URL(calledUrl);
      expect(url.searchParams.get('count')).toBe('5');
    });

    it('formats search results correctly', async () => {
      const mockResults = [
        {
          title: 'First Result',
          url: 'https://example1.com/page',
          description: 'Summary of first result',
          meta_url: { hostname: 'example1.com', favicon: 'https://example1.com/icon.png' },
          page_age: '2025-01-15',
          extra_snippets: ['Additional context about first result'],
        },
        {
          title: 'Second Result',
          url: 'https://example2.com/page',
          description: 'Summary of second result',
          meta_url: { hostname: 'example2.com' },
          age: '3 days ago',
        },
      ];

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBraveResponse(mockResults));

      const result = (await webSearchTools.web_search!.execute!(
        { query: 'test', count: 10, recencyFilter: 'noLimit' },
        mockContext('user-123')
      )) as WebSearchResult;

      if ('error' in result) throw new Error(`Expected success but got error: ${result.error}`);
      expect(result.success).toBe(true);
      expect(result.resultsCount).toBe(2);

      const results = result.results;
      expect(results[0].position).toBe(1);
      expect(results[0].title).toBe('First Result');
      expect(results[0].url).toBe('https://example1.com/page');
      expect(results[0].source).toBe('example1.com');
      expect(results[0].publishDate).toBe('2025-01-15');
      expect(results[0].summary).toContain('Summary of first result');
      expect(results[0].summary).toContain('Additional context about first result');

      expect(results[1].position).toBe(2);
      expect(results[1].publishDate).toBe('3 days ago');
    });

    it('handles empty web results gracefully', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({ query: { original: 'obscure query' } }),
      });

      const result = (await webSearchTools.web_search!.execute!(
        { query: 'obscure query', count: 10, recencyFilter: 'noLimit' },
        mockContext('user-123')
      )) as WebSearchResult;

      if ('error' in result) throw new Error(`Expected success but got error: ${result.error}`);
      expect(result.success).toBe(true);
      expect(result.resultsCount).toBe(0);
      expect(result.results).toEqual([]);
    });

    it('includes metadata with brave search engine', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBraveResponse());

      const result = (await webSearchTools.web_search!.execute!(
        { query: 'test', count: 10, recencyFilter: 'oneMonth', domainFilter: 'github.com' },
        mockContext('user-123')
      )) as WebSearchResult;

      if ('error' in result) throw new Error(`Expected success but got error: ${result.error}`);
      expect(result.metadata.searchEngine).toBe('brave');
      expect(result.metadata.recencyFilter).toBe('oneMonth');
      expect(result.metadata.domainFilter).toBe('github.com');
    });
  });
});

// ─── web_fetch tests ────────────────────────────────────────────────────────

/** Build a minimal fetch Response with a streaming body. */
function mockFetchResponse(
  body: string,
  {
    status = 200,
    contentType = 'text/html; charset=utf-8',
    contentLength,
  }: { status?: number; contentType?: string; contentLength?: number } = {}
) {
  const headers = new Map<string, string>([['content-type', contentType]]);
  if (contentLength !== undefined) headers.set('content-length', String(contentLength));

  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(bytes); c.close(); },
  });

  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { get: (name: string) => headers.get(name) ?? null },
    body: stream,
  };
}

describe('web_fetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
    // Default: public DNS resolves to a public IP
    mockLookupFn.mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has correct tool definition', () => {
    expect(webSearchTools.web_fetch).toBeDefined();
    expect(webSearchTools.web_fetch.description).toContain('Fetch and read');
  });

  it('requires user authentication', async () => {
    await expect(
      webSearchTools.web_fetch!.execute!(
        { url: 'https://example.com', maxLength: 20000 },
        mockContext()
      )
    ).rejects.toThrow('User authentication required');
  });

  describe('SSRF protection', () => {
    it('rejects http:// URLs before any DNS or fetch', async () => {
      const result = await webSearchTools.web_fetch!.execute!(
        { url: 'http://example.com', maxLength: 20000 },
        mockContext('user-123')
      ) as Record<string, unknown>;
      expect(result.success).toBe(false);
      expect(String(result.error)).toMatch(/https/i);
      expect(fetch).not.toHaveBeenCalled();
      expect(mockLookupFn).not.toHaveBeenCalled();
    });

    it.each([
      ['loopback', 'https://127.0.0.1'],
      ['RFC1918 class A', 'https://10.0.0.1'],
      ['RFC1918 class B', 'https://172.16.0.1'],
      ['RFC1918 class C', 'https://192.168.1.1'],
      ['link-local/metadata', 'https://169.254.169.254'],
    ])('blocks %s address %s', async (_label, url) => {
      const result = await webSearchTools.web_fetch!.execute!(
        { url, maxLength: 20000 },
        mockContext('user-123')
      ) as Record<string, unknown>;
      expect(result.success).toBe(false);
      expect(String(result.error)).toMatch(/private|internal/i);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('blocks localhost', async () => {
      const result = await webSearchTools.web_fetch!.execute!(
        { url: 'https://localhost', maxLength: 20000 },
        mockContext('user-123')
      ) as Record<string, unknown>;
      expect(result.success).toBe(false);
      expect(String(result.error)).toMatch(/private|internal/i);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('blocks when DNS resolves to a private IP (DNS rebinding)', async () => {
      mockLookupFn.mockResolvedValue([{ address: '10.0.0.1', family: 4 }] as never);
      const result = await webSearchTools.web_fetch!.execute!(
        { url: 'https://evil.example.com', maxLength: 20000 },
        mockContext('user-123')
      ) as Record<string, unknown>;
      expect(result.success).toBe(false);
      expect(String(result.error)).toMatch(/private|internal/i);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('fails closed when DNS resolution fails', async () => {
      mockLookupFn.mockRejectedValue(new Error('ENOTFOUND'));
      const result = await webSearchTools.web_fetch!.execute!(
        { url: 'https://nxdomain.invalid', maxLength: 20000 },
        mockContext('user-123')
      ) as Record<string, unknown>;
      expect(result.success).toBe(false);
      expect(String(result.error)).toMatch(/resolve/i);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('content validation', () => {
    it('rejects non-HTML content types', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockFetchResponse('%PDF-1.4', { contentType: 'application/pdf' })
      );
      const result = await webSearchTools.web_fetch!.execute!(
        { url: 'https://example.com/doc.pdf', maxLength: 20000 },
        mockContext('user-123')
      ) as Record<string, unknown>;
      expect(result.success).toBe(false);
      expect(String(result.error)).toMatch(/content type/i);
    });

    it('rejects when Content-Length exceeds 5 MB', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockFetchResponse('', { contentLength: 6 * 1024 * 1024 })
      );
      const result = await webSearchTools.web_fetch!.execute!(
        { url: 'https://example.com', maxLength: 20000 },
        mockContext('user-123')
      ) as Record<string, unknown>;
      expect(result.success).toBe(false);
      expect(String(result.error)).toMatch(/too large/i);
    });
  });

  describe('happy path', () => {
    it('returns markdown for valid HTML', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockFetchResponse('<html><body><h1>Hello</h1><p>World</p></body></html>')
      );
      const result = await webSearchTools.web_fetch!.execute!(
        { url: 'https://example.com', maxLength: 20000 },
        mockContext('user-123')
      ) as Record<string, unknown>;
      expect(result.success).toBe(true);
      expect(String(result.content)).toContain('Hello');
      expect(result.truncated).toBe(false);
    });

    it('truncates and flags when content exceeds maxLength', async () => {
      const longHtml = '<p>' + 'a'.repeat(2000) + '</p>';
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockFetchResponse(longHtml));
      const result = await webSearchTools.web_fetch!.execute!(
        { url: 'https://example.com', maxLength: 100 },
        mockContext('user-123')
      ) as Record<string, unknown>;
      expect(result.success).toBe(true);
      expect(result.truncated).toBe(true);
      expect(String(result.content).length).toBeLessThanOrEqual(100);
    });

    it('does not truncate when content fits within maxLength', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockFetchResponse('<p>Short content</p>')
      );
      const result = await webSearchTools.web_fetch!.execute!(
        { url: 'https://example.com', maxLength: 20000 },
        mockContext('user-123')
      ) as Record<string, unknown>;
      expect(result.success).toBe(true);
      expect(result.truncated).toBe(false);
    });
  });
});
