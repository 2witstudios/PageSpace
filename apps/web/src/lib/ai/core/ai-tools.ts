import { driveTools } from '../tools/drive-tools';
import { pageReadTools } from '../tools/page-read-tools';
import { pageWriteTools } from '../tools/page-write-tools';
import { searchTools } from '../tools/search-tools';
import { taskManagementTools } from '../tools/task-management-tools';
import { agentTools } from '../tools/agent-tools';
import { agentCommunicationTools } from '../tools/agent-communication-tools';
import { webSearchTools } from '../tools/web-search-tools';
import { activityTools } from '../tools/activity-tools';
import type { Tool } from 'ai';

/**
 * PageSpace AI Tools - Internal AI SDK tool implementations
 * These tools provide the AI with the ability to interact with PageSpace documents,
 * drives, pages, and AI agents directly through the database with proper permission checking.
 */
export const pageSpaceTools = {
  ...driveTools,
  ...pageReadTools,
  ...pageWriteTools,
  ...searchTools,
  ...taskManagementTools,
  ...agentTools,
  ...agentCommunicationTools,
  ...webSearchTools,
  ...activityTools,
};

export type PageSpaceTools = typeof pageSpaceTools;

/**
 * Get integration tools for a user
 * Dynamically loads tools from user's configured integrations
 */
export async function getIntegrationToolsForUser(userId: string): Promise<Record<string, Tool>> {
  try {
    // Dynamic import to avoid circular dependencies
    const { getUserIntegrationTools } = await import('@/lib/integrations/tool-loader');
    return await getUserIntegrationTools(userId);
  } catch (error) {
    // Log but don't fail - integrations are optional
    console.error('Failed to load integration tools:', error);
    return {};
  }
}

/**
 * Get all tools for a user (PageSpace + integrations)
 * Used by the AI system to get the complete tool set
 */
export async function getAllToolsForUser(userId: string): Promise<Record<string, Tool>> {
  const integrationTools = await getIntegrationToolsForUser(userId);
  return {
    ...pageSpaceTools,
    ...integrationTools,
  };
}