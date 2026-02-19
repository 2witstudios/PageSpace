import { tool } from 'ai';
import { z } from 'zod';
import { type ToolExecutionContext } from '../core';
import { loggers } from '@pagespace/lib/server';
import { maskIdentifier } from '@/lib/logging/mask';

const webSearchLogger = loggers.ai.child({ module: 'web-search-tools' });

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

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

export const webSearchTools = {
  /**
   * Search the web for current information using Brave Search API
   */
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
          source: result.meta_url?.hostname || new URL(result.url).hostname,
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
};
