import { promises as dnsPromises } from 'dns';
import { Agent } from 'undici';
import { tool } from 'ai';
import { z } from 'zod';
import TurndownService from 'turndown';
import type { ToolExecutionContext } from '../core/types';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { maskIdentifier } from '@/lib/logging/mask';
import { isPublicIp, isAllowedFetchTarget, isIpLiteral, PRIVATE_HOST_MESSAGE } from './web-fetch-ssrf';

const webSearchLogger = loggers.ai.child({ module: 'web-search-tools' });

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
const MAX_FETCH_BYTES = 5 * 1024 * 1024; // 5 MB hard cap on buffered response
const MAX_REDIRECTS = 5; // cap on manually-followed redirect hops
const FETCH_TIMEOUT_MS = 15000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function safeHostname(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** Strips query string and fragment before logging to avoid leaking tokens in URL params. */
function redactUrl(url: string): string {
  try { const u = new URL(url); return u.origin + u.pathname; } catch { return '[unparseable url]'; }
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

interface ResolvedAddress {
  address: string;
  family: number;
}

/**
 * Resolves a hostname to all addresses and rejects if ANY is non-public
 * (DNS-rebinding mitigation). IP literals are already validated by
 * {@link isAllowedFetchTarget}, so they skip DNS. Returns the validated
 * addresses so the connection can be pinned to them.
 * Throws on block or DNS failure (fail-closed).
 */
async function resolveValidatedAddresses(hostname: string): Promise<ResolvedAddress[]> {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (isIpLiteral(bare)) {
    return [{ address: bare, family: bare.includes(':') ? 6 : 4 }];
  }

  let addresses: ResolvedAddress[];
  try {
    addresses = await dnsPromises.lookup(hostname, { all: true });
  } catch {
    throw new Error('Unable to resolve hostname');
  }
  if (!addresses.length) throw new Error('Hostname resolved to no addresses');
  for (const { address } of addresses) {
    if (!isPublicIp(address)) throw new Error(PRIVATE_HOST_MESSAGE);
  }
  return addresses;
}

/**
 * Builds an undici dispatcher that pins outbound connections to the already
 * validated addresses, closing the TOCTOU window between DNS validation and
 * connect (a public hostname cannot re-resolve to a private IP at connect time).
 * The TLS servername stays the original hostname, preserving SNI/cert checks.
 * Returns undefined if a dispatcher cannot be constructed (revalidation still
 * applies on every hop).
 */
function createPinnedDispatcher(addresses: ResolvedAddress[]): Agent | undefined {
  if (!addresses.length) return undefined;
  try {
    return new Agent({
      connect: {
        lookup: (_hostname, options, callback) => {
          if (options && options.all) {
            callback(null, addresses.map((a) => ({ address: a.address, family: a.family })));
          } else {
            callback(null, addresses[0].address, addresses[0].family);
          }
        },
      },
    });
  } catch {
    return undefined;
  }
}

async function closeDispatcher(dispatcher: Agent | undefined): Promise<void> {
  try {
    await dispatcher?.close();
  } catch {
    /* best-effort cleanup */
  }
}

type PinnedFetchInit = RequestInit & { dispatcher?: Agent };

interface SafeFetchResult {
  response: Response;
  dispatcher: Agent | undefined;
  finalUrl: string;
}

/**
 * SSRF-safe fetch: follows redirects MANUALLY (redirect: 'manual'), revalidating
 * scheme + host and re-resolving + pinning DNS on EVERY hop. This closes the M2
 * bypass where an allowed initial URL 302s to cloud-metadata/internal hosts.
 * The caller owns the returned dispatcher and must close it after reading the body.
 */
async function ssrfSafeFetch(initialUrl: string, headers: Record<string, string>): Promise<SafeFetchResult> {
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const decision = isAllowedFetchTarget(currentUrl);
    if (!decision.ok) throw new Error(decision.reason ?? PRIVATE_HOST_MESSAGE);

    const addresses = await resolveValidatedAddresses(new URL(currentUrl).hostname);
    const dispatcher = createPinnedDispatcher(addresses);

    const init: PinnedFetchInit = {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    };
    if (dispatcher) init.dispatcher = dispatcher;

    const response = await fetch(currentUrl, init);

    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, dispatcher, finalUrl: currentUrl };
    }

    // Redirect: discard this hop's body + dispatcher, validate the next target.
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => { /* ignore */ });
    await closeDispatcher(dispatcher);

    if (!location) throw new Error('Redirect response missing Location header');
    let next: URL;
    try {
      next = new URL(location, currentUrl);
    } catch {
      throw new Error('Invalid redirect Location');
    }
    currentUrl = next.toString();
  }

  throw new Error('Too many redirects');
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

      // Pure scheme + literal-IP gate (no DNS, no network) before doing any work.
      const targetDecision = isAllowedFetchTarget(url);
      if (!targetDecision.ok) {
        return {
          success: false,
          url,
          error: targetDecision.reason ?? PRIVATE_HOST_MESSAGE,
          content: '',
          nextSteps: ['Provide a publicly accessible https:// URL'],
        };
      }

      let dispatcher: Agent | undefined;
      try {
        webSearchLogger.debug('Fetching URL', { userId: maskIdentifier(userId), url: redactUrl(url) });

        // Follows redirects manually, revalidating + IP-pinning each hop (SSRF-safe).
        const safe = await ssrfSafeFetch(url, { 'User-Agent': 'Mozilla/5.0 (compatible; PageSpace/1.0)' });
        const response = safe.response;
        dispatcher = safe.dispatcher;

        if (!response.ok) {
          throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
          return {
            success: false,
            url,
            error: `Unsupported content type: ${contentType}`,
            content: '',
            nextSteps: ['This URL returns non-HTML content. Try web_search for a different source.'],
          };
        }

        const clHeader = response.headers.get('content-length');
        if (clHeader && Number(clHeader) > MAX_FETCH_BYTES) {
          return {
            success: false,
            url,
            error: `Response too large (${Math.round(Number(clHeader) / 1024 / 1024)} MB, max 5 MB)`,
            content: '',
            nextSteps: ['Try web_search for a summary of this content'],
          };
        }

        // Stream body with hard byte cap to avoid buffering large responses
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Response body is not readable');
        const chunks: Uint8Array[] = [];
        let bytesRead = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          const remaining = MAX_FETCH_BYTES - bytesRead;
          if (value.length >= remaining) {
            chunks.push(value.subarray(0, remaining));
            bytesRead += remaining;
            await reader.cancel();
            break;
          }
          chunks.push(value);
          bytesRead += value.length;
        }
        const allBytes = new Uint8Array(bytesRead);
        let offset = 0;
        for (const chunk of chunks) { allBytes.set(chunk, offset); offset += chunk.length; }
        const html = new TextDecoder().decode(allBytes);

        const cleaned = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '');

        const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
        const fullMarkdown = td.turndown(cleaned);
        const markdown = fullMarkdown.slice(0, maxLength);

        webSearchLogger.info('URL fetch complete', {
          userId: maskIdentifier(userId),
          url: redactUrl(url),
          markdownLength: markdown.length,
          truncated: fullMarkdown.length > maxLength,
        });

        return {
          success: true,
          url,
          contentLength: markdown.length,
          truncated: fullMarkdown.length > maxLength,
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
          url: redactUrl(url),
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
      } finally {
        await closeDispatcher(dispatcher);
      }
    },
  }),
};
