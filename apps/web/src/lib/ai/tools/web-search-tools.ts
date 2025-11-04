import { tool } from 'ai';
import { z } from 'zod';
import { ToolExecutionContext } from '../types';
import { getDefaultPageSpaceSettings, getUserGLMSettings } from '../ai-utils';
import { loggers } from '@pagespace/lib/server';
import { maskIdentifier } from '@/lib/logging/mask';

const webSearchLogger = loggers.ai.child({ module: 'web-search-tools' });

interface WebSearchResult {
  title: string;
  link: string;
  content: string;
  media: string;
  icon: string;
  publish_date?: string;
  refer: string;
}

interface WebSearchResponse {
  created: number;
  id: string;
  request_id: string;
  search_result: WebSearchResult[];
}

/**
 * Performs web search using GLM's Web Search API
 * Requires GLM API key to be configured (either default PageSpace key or user's own key)
 */
async function performWebSearch({
  query,
  count = 10,
  searchEngine = 'search-prime',
  domainFilter,
  recencyFilter = 'noLimit',
  userId,
}: {
  query: string;
  count?: number;
  searchEngine?: 'search-prime';
  domainFilter?: string;
  recencyFilter?: 'noLimit' | 'day' | 'week' | 'month' | 'year';
  userId: string;
}): Promise<WebSearchResponse> {
  // Get GLM API key - try default PageSpace settings first, then user settings
  let glmApiKey: string | undefined;

  const defaultSettings = await getDefaultPageSpaceSettings();
  if (defaultSettings?.provider === 'glm') {
    glmApiKey = defaultSettings.apiKey;
  } else {
    // Try user's personal GLM settings
    const userSettings = await getUserGLMSettings(userId);
    if (userSettings?.apiKey) {
      glmApiKey = userSettings.apiKey;
    }
  }

  if (!glmApiKey) {
    throw new Error('GLM API key not configured. Web search requires a GLM API key to be set in PageSpace settings or your personal AI settings.');
  }

  webSearchLogger.debug('Performing web search', {
    userId: maskIdentifier(userId),
    query: query.substring(0, 100),
    count,
    searchEngine,
    hasDomainFilter: !!domainFilter,
    recencyFilter,
  });

  try {
    // Build request body according to GLM Web Search API spec
    const requestBody: Record<string, unknown> = {
      search_engine: searchEngine,
      search_query: query,
      count,
      search_recency_filter: recencyFilter,
    };

    if (domainFilter) {
      requestBody.search_domain_filter = domainFilter;
    }

    // Call GLM Web Search API
    const response = await fetch('https://api.z.ai/api/tools/web-search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${glmApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      webSearchLogger.error('GLM Web Search API error', undefined, {
        userId: maskIdentifier(userId),
        status: response.status,
        statusText: response.statusText,
        error: errorText,
      });
      throw new Error(`Web search failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as WebSearchResponse;

    webSearchLogger.info('Web search completed successfully', {
      userId: maskIdentifier(userId),
      resultsCount: data.search_result?.length || 0,
      requestId: data.request_id,
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
   * Search the web for current information using GLM's Web Search API
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
      count: z.number().min(1).max(50).optional().default(10).describe('Number of results to return (1-50, default 10)'),
      domainFilter: z.string().optional().describe('Optional: Limit search to specific domain (e.g., "docs.python.org", "github.com")'),
      recencyFilter: z.enum(['noLimit', 'day', 'week', 'month', 'year']).optional().default('noLimit').describe('Filter by recency: "day" (last 24h), "week", "month", "year", or "noLimit"'),
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
          recencyFilter: recencyFilter as 'noLimit' | 'day' | 'week' | 'month' | 'year',
          userId,
        });

        // Format results for the AI to use
        const formattedResults = searchResponse.search_result.map((result, index) => ({
          position: index + 1,
          title: result.title,
          url: result.link,
          summary: result.content,
          source: result.media,
          publishDate: result.publish_date || 'Unknown',
          reference: result.refer,
        }));

        return {
          success: true,
          query,
          resultsCount: formattedResults.length,
          results: formattedResults,
          summary: `Found ${formattedResults.length} web results for "${query}"`,
          metadata: {
            searchEngine: 'search-prime',
            recencyFilter,
            domainFilter: domainFilter || 'all domains',
            requestId: searchResponse.request_id,
            timestamp: new Date(searchResponse.created * 1000).toISOString(),
          },
          nextSteps: [
            'Analyze the search results and synthesize key information',
            'Cite sources using the reference numbers (e.g., [ref_1])',
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

        // Return error information to the AI
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error occurred',
          query,
          resultsCount: 0,
          results: [],
          summary: `Web search failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          nextSteps: [
            'Check if GLM API key is configured in PageSpace settings',
            'Try a different search query',
            'If the error persists, inform the user that web search is temporarily unavailable',
          ],
        };
      }
    },
  }),
};
