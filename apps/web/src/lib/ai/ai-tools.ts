import { driveTools } from './tools/drive-tools';
import { pageReadTools } from './tools/page-read-tools';
import { pageWriteTools } from './tools/page-write-tools';
import { agentTools } from './tools/agent-tools';

/**
 * PageSpace AI Tools - Internal AI SDK tool implementations
 * These tools provide the AI with the ability to interact with PageSpace documents,
 * drives, and pages directly through the database with proper permission checking.
 * Also includes agent discovery and invocation tools for AI agent orchestration.
 */
export const pageSpaceTools = {
  ...driveTools,
  ...pageReadTools,
  ...pageWriteTools,
  ...agentTools,
};

export type PageSpaceTools = typeof pageSpaceTools;