import { driveTools } from './tools/drive-tools';
import { pageReadTools } from './tools/page-read-tools';
import { pageWriteTools } from './tools/page-write-tools';
import { searchTools } from './tools/search-tools';
import { taskManagementTools } from './tools/task-management-tools';
import { batchOperationsTools } from './tools/batch-operations-tools';

/**
 * PageSpace AI Tools - Internal AI SDK tool implementations
 * These tools provide the AI with the ability to interact with PageSpace documents,
 * drives, and pages directly through the database with proper permission checking.
 */
export const pageSpaceTools = {
  ...driveTools,
  ...pageReadTools,
  ...pageWriteTools,
  ...searchTools,
  ...taskManagementTools,
  ...batchOperationsTools,
};

export type PageSpaceTools = typeof pageSpaceTools;