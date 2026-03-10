import { type ToolSet } from 'ai';
import { loggers } from '@pagespace/lib/server';
import { maskIdentifier } from '@/lib/logging/mask';
import {
  pageSpaceTools,
  filterToolsForReadOnly,
  filterToolsForWebSearch,
  convertMCPToolsToAISDKSchemas,
  parseMCPToolName,
  sanitizeToolNamesForProvider,
  getModelCapabilities,
} from '@/lib/ai/core';
import { mergeToolSets } from '@/lib/ai/core/tool-utils';
import { getMCPBridge } from '@/lib/mcp';
import { getDriveAccess } from '@pagespace/lib/services/drive-service';
import type { MCPTool } from '@/types/mcp';
import type { LocationContext } from './types';

export async function buildToolSet(params: {
  userId: string;
  readOnlyMode: boolean;
  webSearchMode: boolean;
  locationContext?: LocationContext;
  mcpTools?: MCPTool[];
}): Promise<ToolSet> {
  const { userId, readOnlyMode, webSearchMode, locationContext, mcpTools } = params;

  const postReadOnlyTools = filterToolsForReadOnly(pageSpaceTools, readOnlyMode);
  let finalTools: ToolSet = filterToolsForWebSearch(postReadOnlyTools, webSearchMode) as ToolSet;

  loggers.api.debug('Global Assistant Chat API: Tool modes', {
    isReadOnly: readOnlyMode,
    webSearchEnabled: webSearchMode,
    totalTools: Object.keys(finalTools).length
  });

  finalTools = await mergeIntegrationTools(finalTools, userId, locationContext);

  if (mcpTools && mcpTools.length > 0) {
    finalTools = await mergeMCPTools(finalTools, userId, mcpTools);
  }

  return finalTools;
}

async function mergeIntegrationTools(
  currentTools: ToolSet,
  userId: string,
  locationContext?: LocationContext
): Promise<ToolSet> {
  try {
    const { resolveGlobalAssistantIntegrationTools } = await import('@/lib/ai/core/integration-tool-resolver');
    let currentDriveId = locationContext?.currentDrive?.id || null;
    let userDriveRole: 'OWNER' | 'ADMIN' | 'MEMBER' | null = null;

    if (currentDriveId) {
      const access = await getDriveAccess(currentDriveId, userId);
      if (!access.isMember) {
        currentDriveId = null;
      } else {
        userDriveRole = access.role;
      }
    }

    const integrationTools = await resolveGlobalAssistantIntegrationTools({
      userId,
      driveId: currentDriveId,
      userDriveRole,
    });

    if (Object.keys(integrationTools).length > 0) {
      const merged = mergeToolSets(currentTools, integrationTools);
      loggers.api.info('Global Assistant: Merged integration tools', {
        integrationToolCount: Object.keys(integrationTools).length,
        totalTools: Object.keys(merged).length,
      });
      return merged;
    }
  } catch (error) {
    loggers.api.error('Global Assistant: Failed to resolve integration tools', error as Error);
  }

  return currentTools;
}

async function mergeMCPTools(
  currentTools: ToolSet,
  userId: string,
  mcpTools: MCPTool[]
): Promise<ToolSet> {
  try {
    loggers.api.info('Global Assistant Chat API: Integrating MCP tools from desktop', {
      mcpToolCount: mcpTools.length,
      toolNames: mcpTools.map((t: MCPTool) => `mcp:${t.serverName}:${t.name}`),
      userId: maskIdentifier(userId),
    });

    const mcpToolSchemas = convertMCPToolsToAISDKSchemas(mcpTools);

    const mcpToolsWithExecute: Record<string, unknown> = {};
    for (const [toolName, toolSchema] of Object.entries(mcpToolSchemas)) {
      mcpToolsWithExecute[toolName] = {
        ...toolSchema,
        execute: async (args: Record<string, unknown>) => {
          const parsed = parseMCPToolName(toolName);
          if (!parsed) {
            throw new Error(`Invalid MCP tool name format: ${toolName}`);
          }
          const { serverName, toolName: originalToolName } = parsed;

          loggers.api.debug('MCP Tool Execute: Calling tool via bridge', {
            toolName,
            serverName,
            originalToolName,
            userId: maskIdentifier(userId)
          });

          const result = await getMCPBridge().executeTool(userId, serverName, originalToolName, args);
          return result;
        }
      };
    }

    const merged = sanitizeToolNamesForProvider({ ...currentTools, ...mcpToolsWithExecute } as Record<string, ToolSet[string]>) as ToolSet;

    loggers.api.info('Global Assistant Chat API: Successfully merged MCP tools', {
      totalTools: Object.keys(merged).length,
      mcpTools: Object.keys(mcpToolSchemas).length,
      pageSpaceTools: Object.keys(merged).length - Object.keys(mcpToolSchemas).length
    });

    return merged;
  } catch (error) {
    loggers.api.error('Global Assistant Chat API: Failed to integrate MCP tools', error as Error, {
      userId: maskIdentifier(userId),
    });
    return currentTools;
  }
}
