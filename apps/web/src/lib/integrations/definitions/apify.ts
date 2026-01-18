/**
 * Apify Integration Definition
 *
 * Apify is a web scraping and automation platform that provides actors (pre-built
 * scrapers and automation tools) that can be run via API.
 *
 * Docs: https://docs.apify.com/api/v2
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { IntegrationDefinition, IntegrationToolContext } from '../types';
import type { ToolExecutionContext } from '@/lib/ai/core/types';

const APIFY_BASE_URL = 'https://api.apify.com/v2';

/**
 * Make an authenticated request to Apify API
 */
async function apifyRequest(
  path: string,
  apiKey: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = `${APIFY_BASE_URL}${path}`;
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    ...options.headers,
  };

  return fetch(url, { ...options, headers });
}

/**
 * Create Apify tools from user configuration
 */
function createApifyTools(context: IntegrationToolContext) {
  const { apiKey } = context;

  if (!apiKey) {
    // Return empty tools if no API key - tools won't be available
    return {};
  }

  return {
    /**
     * Run an Apify actor and get results
     */
    apify_run_actor: tool({
      description: `Run an Apify actor (web scraper, automation, or data extraction tool) and get the results.

Use this when:
- User needs to scrape data from websites
- User wants to run web automation tasks
- User needs to extract structured data from web pages
- User wants to use pre-built scrapers for popular sites

Common actors include:
- apify/web-scraper: General-purpose web scraper
- apify/cheerio-scraper: Fast scraper for static pages
- apify/puppeteer-scraper: Scraper for dynamic JS-rendered pages
- apify/instagram-scraper: Instagram data extraction
- Various community actors for specific use cases

The actor runs asynchronously. This tool starts the run and waits for completion.`,
      inputSchema: z.object({
        actorId: z.string().describe('Actor ID in format "username/actor-name" (e.g., "apify/web-scraper")'),
        input: z.record(z.unknown()).optional().describe('Input configuration for the actor (varies by actor)'),
        waitForFinish: z.number().min(0).max(300).optional().default(120).describe('Maximum seconds to wait for completion (default 120, max 300)'),
        memoryMbytes: z.number().min(128).max(32768).optional().describe('Memory allocation in MB (128-32768)'),
      }),
      execute: async ({ actorId, input, waitForFinish = 120, memoryMbytes }, { experimental_context }) => {
        const toolContext = experimental_context as ToolExecutionContext;
        if (!toolContext?.userId) {
          throw new Error('User authentication required');
        }

        try {
          // Start the actor run
          const startResponse = await apifyRequest(
            `/acts/${encodeURIComponent(actorId)}/runs`,
            apiKey,
            {
              method: 'POST',
              body: JSON.stringify({
                ...(input && { input }),
                ...(memoryMbytes && { memoryMbytes }),
              }),
            }
          );

          if (!startResponse.ok) {
            const error = await startResponse.text();
            return {
              success: false,
              error: `Failed to start actor: ${startResponse.status} - ${error}`,
              actorId,
            };
          }

          const runData = await startResponse.json() as { data: { id: string; status: string } };
          const runId = runData.data.id;

          // Wait for completion
          const startTime = Date.now();
          const timeout = waitForFinish * 1000;
          let status = runData.data.status;

          while (['READY', 'RUNNING'].includes(status) && (Date.now() - startTime) < timeout) {
            await new Promise(resolve => setTimeout(resolve, 2000)); // Poll every 2 seconds

            const statusResponse = await apifyRequest(`/actor-runs/${runId}`, apiKey);
            if (!statusResponse.ok) {
              return {
                success: false,
                error: 'Failed to check run status',
                runId,
                actorId,
              };
            }

            const statusData = await statusResponse.json() as { data: { status: string } };
            status = statusData.data.status;
          }

          if (status !== 'SUCCEEDED') {
            return {
              success: false,
              error: `Actor run ended with status: ${status}`,
              runId,
              actorId,
              status,
              nextSteps: [
                status === 'RUNNING' ? 'The actor is still running. Try again later with a longer waitForFinish value.' : '',
                'Check the actor logs on Apify console for details',
                'Verify the input configuration is correct for this actor',
              ].filter(Boolean),
            };
          }

          // Get the results from default dataset
          const datasetResponse = await apifyRequest(
            `/actor-runs/${runId}/dataset/items?clean=true&limit=100`,
            apiKey
          );

          if (!datasetResponse.ok) {
            return {
              success: true,
              warning: 'Actor completed but failed to retrieve results',
              runId,
              actorId,
              status: 'SUCCEEDED',
            };
          }

          const results = await datasetResponse.json();

          return {
            success: true,
            actorId,
            runId,
            status: 'SUCCEEDED',
            itemCount: Array.isArray(results) ? results.length : 0,
            results: Array.isArray(results) ? results.slice(0, 50) : results, // Limit to 50 items
            nextSteps: [
              'Analyze the scraped data and extract relevant information',
              'If more items exist, use apify_get_dataset to paginate through results',
              'Present findings to the user in a clear format',
            ],
          };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error occurred',
            actorId,
          };
        }
      },
    }),

    /**
     * List available actors in user's Apify account
     */
    apify_list_actors: tool({
      description: `List available Apify actors in the user's account. Use this to discover what actors are available before running them.`,
      inputSchema: z.object({
        limit: z.number().min(1).max(100).optional().default(25).describe('Maximum number of actors to return'),
        offset: z.number().min(0).optional().default(0).describe('Pagination offset'),
      }),
      execute: async ({ limit = 25, offset = 0 }, { experimental_context }) => {
        const toolContext = experimental_context as ToolExecutionContext;
        if (!toolContext?.userId) {
          throw new Error('User authentication required');
        }

        try {
          const response = await apifyRequest(
            `/acts?limit=${limit}&offset=${offset}`,
            apiKey
          );

          if (!response.ok) {
            const error = await response.text();
            return {
              success: false,
              error: `Failed to list actors: ${response.status} - ${error}`,
            };
          }

          const data = await response.json() as {
            data: {
              items: Array<{
                id: string;
                name: string;
                username: string;
                title?: string;
                description?: string;
              }>;
              total: number;
            };
          };

          return {
            success: true,
            actors: data.data.items.map(actor => ({
              id: `${actor.username}/${actor.name}`,
              name: actor.title || actor.name,
              description: actor.description?.substring(0, 200),
            })),
            total: data.data.total,
            offset,
            limit,
            nextSteps: [
              'Choose an actor based on the task requirements',
              'Use apify_run_actor with the actor ID to execute it',
              'Check actor documentation for required input parameters',
            ],
          };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error occurred',
          };
        }
      },
    }),

    /**
     * Get items from an Apify dataset
     */
    apify_get_dataset: tool({
      description: `Retrieve items from an Apify dataset. Use this to get results from previous actor runs or to paginate through large result sets.`,
      inputSchema: z.object({
        datasetId: z.string().describe('Dataset ID to retrieve items from'),
        limit: z.number().min(1).max(1000).optional().default(100).describe('Maximum items to return'),
        offset: z.number().min(0).optional().default(0).describe('Pagination offset'),
      }),
      execute: async ({ datasetId, limit = 100, offset = 0 }, { experimental_context }) => {
        const toolContext = experimental_context as ToolExecutionContext;
        if (!toolContext?.userId) {
          throw new Error('User authentication required');
        }

        try {
          const response = await apifyRequest(
            `/datasets/${datasetId}/items?clean=true&limit=${limit}&offset=${offset}`,
            apiKey
          );

          if (!response.ok) {
            const error = await response.text();
            return {
              success: false,
              error: `Failed to get dataset items: ${response.status} - ${error}`,
              datasetId,
            };
          }

          const items = await response.json();

          return {
            success: true,
            datasetId,
            itemCount: Array.isArray(items) ? items.length : 0,
            items: Array.isArray(items) ? items : [],
            offset,
            limit,
            nextSteps: [
              'Process the retrieved data',
              'Use offset parameter to get more items if needed',
            ],
          };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error occurred',
            datasetId,
          };
        }
      },
    }),
  };
}

/**
 * Validate Apify API credentials
 */
async function validateApifyCredentials(
  _config: Record<string, unknown>,
  apiKey?: string
): Promise<{ valid: boolean; message: string }> {
  if (!apiKey) {
    return { valid: false, message: 'API key is required' };
  }

  try {
    // Test credentials by fetching user info
    const response = await apifyRequest('/users/me', apiKey);

    if (!response.ok) {
      if (response.status === 401) {
        return { valid: false, message: 'Invalid API key' };
      }
      return { valid: false, message: `API error: ${response.status}` };
    }

    const userData = await response.json() as { data: { username: string } };
    return {
      valid: true,
      message: `Connected as ${userData.data.username}`,
    };
  } catch (error) {
    return {
      valid: false,
      message: error instanceof Error ? error.message : 'Connection failed',
    };
  }
}

/**
 * Apify Integration Definition
 */
export const apifyIntegration: IntegrationDefinition = {
  id: 'apify',
  name: 'Apify',
  description: 'Web scraping and automation platform with hundreds of pre-built actors for data extraction, browser automation, and more.',
  tagline: 'Web scraping and data extraction',
  icon: 'Globe', // lucide-react icon name
  category: 'data',
  docsUrl: 'https://docs.apify.com',
  requiresApiKey: true,
  apiKeyLabel: 'API Token',
  apiKeyDescription: 'Your Apify API token from Settings → Integrations in Apify Console',
  configFields: [], // Apify only needs API key, no additional config
  tools: [
    {
      name: 'apify_run_actor',
      displayName: 'Run Actor',
      description: 'Run an Apify actor (web scraper/automation) and get results',
      isWriteTool: false,
      tags: ['scraping', 'automation', 'data'],
    },
    {
      name: 'apify_list_actors',
      displayName: 'List Actors',
      description: 'List available Apify actors in your account',
      isWriteTool: false,
      tags: ['discovery'],
    },
    {
      name: 'apify_get_dataset',
      displayName: 'Get Dataset',
      description: 'Retrieve items from an Apify dataset',
      isWriteTool: false,
      tags: ['data'],
    },
  ],
  createTools: createApifyTools,
  validate: validateApifyCredentials,
};
