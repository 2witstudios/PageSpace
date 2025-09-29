import { experimental_createMCPClient, type Tool } from 'ai';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loggers } from '@pagespace/lib/server';

const logger = loggers.ai.child({ module: 'internet-tools' });

interface LoadedMCPTools {
  tools: Record<string, Tool>;
  dispose: () => Promise<void>;
}

const DEFAULT_WEB_SEARCH_URL = 'https://api.z.ai/api/mcp/web_search_prime/mcp';

/**
 * Normalizes a partial tool record into a plain Record<string, Tool>
 */
export function toToolRecord(tools: Partial<Record<string, Tool>>): Record<string, Tool> {
  const normalized: Record<string, Tool> = {};

  for (const [name, tool] of Object.entries(tools)) {
    if (tool) {
      normalized[name] = tool;
    }
  }

  return normalized;
}

/**
 * Loads the Z.AI Web Search MCP tools (webSearchPrime)
 */
async function loadZaiWebSearchTools(): Promise<LoadedMCPTools | null> {
  const apiKey = process.env.ZAI_MCP_API_KEY || process.env.GLM_DEFAULT_API_KEY;

  if (!apiKey || apiKey === 'your_glm_api_key_here') {
    logger.debug('Z.AI web search disabled: missing API key');
    return null;
  }

  const endpoint = process.env.ZAI_WEB_SEARCH_MCP_URL || DEFAULT_WEB_SEARCH_URL;

  try {
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
    });

    const client = await experimental_createMCPClient({ transport });
    const toolSet = await client.tools();
    const normalizedTools = toToolRecord(toolSet);

    if (Object.keys(normalizedTools).length === 0) {
      logger.warn('Z.AI web search MCP returned no tools');
      await client.close();
      return null;
    }

    return {
      tools: normalizedTools,
      dispose: async () => {
        try {
          await client.close();
        } catch (error) {
          logger.debug('Error closing Z.AI MCP client', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    } satisfies LoadedMCPTools;
  } catch (error) {
    logger.error('Failed to load Z.AI web search MCP tools', error instanceof Error ? error : undefined, {
      endpoint,
    });
    return null;
  }
}

export interface InternetToolAugmentationResult {
  tools: Record<string, Tool>;
  dispose?: () => Promise<void>;
  addedToolCount: number;
}

/**
 * Augments an existing toolset with internet-enabled MCP tools for supported providers
 */
export async function augmentToolsWithInternetAccess(
  baseTools: Record<string, Tool>,
  provider: string | undefined
): Promise<InternetToolAugmentationResult> {
  if (provider !== 'pagespace') {
    return { tools: baseTools, addedToolCount: 0 };
  }

  const externalTools = await loadZaiWebSearchTools();

  if (!externalTools) {
    return { tools: baseTools, addedToolCount: 0 };
  }

  const combinedTools = { ...baseTools, ...externalTools.tools };

  logger.debug('Added internet-enabled MCP tools for PageSpace provider', {
    toolNames: Object.keys(externalTools.tools),
  });

  return {
    tools: combinedTools,
    dispose: externalTools.dispose,
    addedToolCount: Object.keys(externalTools.tools).length,
  } satisfies InternetToolAugmentationResult;
}
