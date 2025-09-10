import { driveTools } from './tools/drive-tools';
import { pageReadTools } from './tools/page-read-tools';
import { pageWriteTools } from './tools/page-write-tools';
import { searchTools } from './tools/search-tools';
import { taskManagementTools } from './tools/task-management-tools';
import { batchOperationsTools } from './tools/batch-operations-tools';
import { agentTools } from './tools/agent-tools';

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
  ...batchOperationsTools,
  ...agentTools,
};

export type PageSpaceTools = typeof pageSpaceTools;