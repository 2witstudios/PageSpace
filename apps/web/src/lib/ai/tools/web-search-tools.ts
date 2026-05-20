import { tool } from 'ai';
import { z } from 'zod';
import TurndownService from 'turndown';
import { type ToolExecutionContext } from '../core';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { maskIdentifier } from '@/lib/logging/mask';

const webSearchLogger = loggers.ai.child({ module: 'web-search-tools' });

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

function safeHostname(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** Map internal recency filter values to Brave's freshness parameter */
const FRESHNESS_MAP: Record<string, string | undefined> = {
  noLimit: undefined,
  oneDay: 'pd',
  oneWeek: 'pw',
  oneMonth: 'pm',
  oneYear: 'py',
};

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
  meta_url?: { hostname?: string; favicon?: string };
  page_age?: string;
  age?: string;
  extra_snippets?: string[];
}

interface BraveSearchResponse {
  web?: { results: BraveSearchResult[] };
  query?: { original: string };
}

/**
 * Performs web search using Brave Search API.
 * Requires BRAVE_API_KEY environment variable.
 */
async function performWebSearch({
  query,
  count = 10,
  domainFilter,
  recencyFilter = 'noLimit',
  userId,
}: {
  query: string;
  count?: number;
  domainFilter?: string;
  recencyFilter?: 'noLimit' | 'oneDay' | 'oneWeek' | 'oneMonth' | 'oneYear';
  userId: string;
}): Promise<BraveSearchResponse> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    throw new Error('BRAVE_API_KEY is not configured. Web search requires a Brave Search API key.');
  }

  // Prepend site: filter to query when domain filter is specified
  const searchQuery = domainFilter ? `site:${domainFilter} ${query}` : query;

  webSearchLogger.debug('Performing web search', {
    userId: maskIdentifier(userId),
    query: query.substring(0, 100),
    count,
    hasDomainFilter: !!domainFilter,
    recencyFilter,
  });

  try {
    const params = new URLSearchParams({
      q: searchQuery,
      count: String(count),
      extra_snippets: 'true',
    });

    const freshness = FRESHNESS_MAP[recencyFilter];
    if (freshness) {
      params.set('freshness', freshness);
    }

    const response = await fetch(`${BRAVE_SEARCH_URL}?${params}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': apiKey,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      webSearchLogger.error('Brave Search API error', undefined, {
        userId: maskIdentifier(userId),
        status: response.status,
        statusText: response.statusText,
        error: errorText,
      });
      throw new Error(`Web search failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as BraveSearchResponse;

    webSearchLogger.info('Web search completed successfully', {
      userId: maskIdentifier(userId),
      resultsCount: data.web?.results?.length || 0,
    });

    return data;
  } catch (error) {
    webSearchLogger.error('Web search execution failed', error as Error, {
      userId: maskIdentifier(userId),
      query: query.substring(0, 100),
    });
    throw error;
  }
}

/** Block SSRF: rejects loopback, RFC1918, link-local, and cloud-metadata hosts. */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  const ipv4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10) return true;                          // 10.0.0.0/8
    if (a === 127) return true;                         // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true;            // 169.254.0.0/16 link-local + AWS metadata
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
    if (a === 192 && b === 168) return true;            // 192.168.0.0/16
  }
  return false;
}

export const webSearchTools = {
  web_search: tool({
    description: `Search the web for current information, news, documentation, and real-time data. Use this when:
- User asks about current events, news, or recent developments
- Information needed is time-sensitive or outside your knowledge cutoff
- User wants to research a topic with up-to-date web sources
- Looking for documentation, guides, or resources that may have been updated
- Verifying facts or finding authoritative sources

Returns structured search results with titles, links, summaries, and publication dates.`,
    inputSchema: z.object({
      query: z.string().describe('Search query - be specific and use natural language (e.g., "latest developments in AI safety 2025", "best practices for React Server Components")'),
      count: z.number().min(1).max(20).optional().default(10).describe('Number of results to return (1-20, default 10)'),
      domainFilter: z.string().optional().describe('Optional: Limit search to specific domain (e.g., "docs.python.org", "github.com")'),
      recencyFilter: z.enum(['noLimit', 'oneDay', 'oneWeek', 'oneMonth', 'oneYear']).optional().default('noLimit').describe('Filter by recency: "oneDay" (last 24h), "oneWeek", "oneMonth", "oneYear", or "noLimit"'),
    }),
    execute: async ({ query, count = 10, domainFilter, recencyFilter = 'noLimit' }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required for web search');
      }

      try {
        const searchResponse = await performWebSearch({
          query,
          count,
          domainFilter,
          recencyFilter: recencyFilter as 'noLimit' | 'oneDay' | 'oneWeek' | 'oneMonth' | 'oneYear',
          userId,
        });

        const results = searchResponse.web?.results || [];

        const formattedResults = results.map((result, index) => ({
          position: index + 1,
          title: result.title,
          url: result.url,
          summary: [
            result.description,
            ...(result.extra_snippets || []),
          ].filter(Boolean).join('\n\n'),
          source: result.meta_url?.hostname || safeHostname(result.url),
          favicon: result.meta_url?.favicon,
          publishDate: result.page_age || result.age || 'Unknown',
        }));

        return {
          success: true,
          query,
          resultsCount: formattedResults.length,
          results: formattedResults,
          summary: `Found ${formattedResults.length} web results for "${query}"`,
          metadata: {
            searchEngine: 'brave',
            recencyFilter,
            domainFilter: domainFilter || 'all domains',
          },
          nextSteps: [
            'Analyze the search results and synthesize key information',
            'Cite sources using the URLs provided',
            'If results are not relevant, try refining the search query',
            'Use domainFilter to focus on specific authoritative sources',
            'Use recencyFilter to find more recent information if needed',
          ],
        };
      } catch (error) {
        webSearchLogger.error('Web search tool execution failed', error as Error, {
          userId: maskIdentifier(userId),
          query: query.substring(0, 100),
        });

        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error occurred',
          query,
          resultsCount: 0,
          results: [],
          summary: `Web search failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          nextSteps: [
            'Check if BRAVE_API_KEY environment variable is configured',
            'Try a different search query',
            'If the error persists, inform the user that web search is temporarily unavailable',
          ],
        };
      }
    },
  }),

  web_fetch: tool({
    description: `Fetch and read the full content of a specific URL as clean markdown. Use this when:
- You have a direct URL and need its full content (not just a snippet)
- web_search returned a link you want to read in detail
- User provides a URL they want you to read
- Fetching documentation, articles, GitHub files, API references

Returns the page content converted to readable markdown.`,
    inputSchema: z.object({
      url: z.string().url().describe('The full URL to fetch (must start with https://)'),
      maxLength: z.number().min(1000).max(50000).optional().default(20000)
        .describe('Max characters of markdown to return (default 20000)'),
    }),
    execute: async ({ url, maxLength = 20000 }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) throw new Error('User authentication required');

      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') {
          return { success: false, url, error: 'Only HTTPS URLs are supported', content: '', nextSteps: ['Use an https:// URL'] };
        }
        if (isPrivateHost(parsed.hostname)) {
          return { success: false, url, error: 'Fetching private or internal hosts is not allowed', content: '', nextSteps: ['Provide a publicly accessible URL'] };
        }

        webSearchLogger.debug('Fetching URL', { userId: maskIdentifier(userId), url });

        const response = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PageSpace/1.0)' },
          signal: AbortSignal.timeout(15000),
        });

        if (!response.ok) {
          throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
        }

        const html = await response.text();
        const cleaned = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '');

        const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
        const markdown = td.turndown(cleaned).slice(0, maxLength);

        webSearchLogger.info('URL fetch complete', {
          userId: maskIdentifier(userId),
          url,
          markdownLength: markdown.length,
          truncated: markdown.length === maxLength,
        });

        return {
          success: true,
          url,
          contentLength: markdown.length,
          truncated: markdown.length === maxLength,
          content: markdown,
          nextSteps: [
            'Read and synthesize the fetched content',
            'Cite the source URL when referencing this content',
            'If content is truncated, focus on the most relevant sections',
          ],
        };
      } catch (error) {
        webSearchLogger.error('URL fetch failed', error as Error, {
          userId: maskIdentifier(userId),
          url,
        });
        return {
          success: false,
          url,
          error: error instanceof Error ? error.message : 'Unknown error',
          content: '',
          nextSteps: [
            'Check the URL is publicly accessible (not behind auth or paywall)',
            'Try web_search to find an alternative source',
          ],
        };
      }
    },
  }),
};
