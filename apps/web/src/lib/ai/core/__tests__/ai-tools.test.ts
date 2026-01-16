/**
 * @scaffold - aggregation tripwire
 *
 * This test validates that pageSpaceTools correctly aggregates all tool modules.
 * It's a scaffold test because:
 * - The unit is pure wiring/aggregation with no business logic
 * - Changes here indicate tools were added/removed/renamed
 * - Failures should prompt review of whether the change was intentional
 */
import { describe, it, expect, vi } from 'vitest';

// Mock all tool modules to avoid database dependencies
vi.mock('../../tools/drive-tools', () => ({
  driveTools: {
    list_drives: { name: 'list_drives', description: 'List drives' },
    create_drive: { name: 'create_drive', description: 'Create drive' },
    rename_drive: { name: 'rename_drive', description: 'Rename drive' },
  },
}));

vi.mock('../../tools/page-read-tools', () => ({
  pageReadTools: {
    list_pages: { name: 'list_pages', description: 'List pages' },
    read_page: { name: 'read_page', description: 'Read page' },
    list_trash: { name: 'list_trash', description: 'List trash' },
  },
}));

vi.mock('../../tools/page-write-tools', () => ({
  pageWriteTools: {
    replace_lines: { name: 'replace_lines', description: 'Replace lines' },
    create_page: { name: 'create_page', description: 'Create page' },
    rename_page: { name: 'rename_page', description: 'Rename page' },
    trash: { name: 'trash', description: 'Trash page' },
    restore: { name: 'restore', description: 'Restore page' },
    move_page: { name: 'move_page', description: 'Move page' },
    edit_sheet_cells: { name: 'edit_sheet_cells', description: 'Edit sheet cells' },
  },
}));

vi.mock('../../tools/search-tools', () => ({
  searchTools: {
    regex_search: { name: 'regex_search', description: 'Regex search' },
    glob_search: { name: 'glob_search', description: 'Glob search' },
    multi_drive_search: { name: 'multi_drive_search', description: 'Multi drive search' },
  },
}));

vi.mock('../../tools/task-management-tools', () => ({
  taskManagementTools: {
    update_task: { name: 'update_task', description: 'Update task' },
  },
}));

vi.mock('../../tools/agent-tools', () => ({
  agentTools: {
    update_agent_config: { name: 'update_agent_config', description: 'Update agent config' },
  },
}));

vi.mock('../../tools/agent-communication-tools', () => ({
  agentCommunicationTools: {
    list_agents: { name: 'list_agents', description: 'List agents' },
    multi_drive_list_agents: { name: 'multi_drive_list_agents', description: 'Multi drive list agents' },
    ask_agent: { name: 'ask_agent', description: 'Ask agent' },
  },
}));

vi.mock('../../tools/web-search-tools', () => ({
  webSearchTools: {
    web_search: { name: 'web_search', description: 'Web search' },
  },
}));

vi.mock('../../tools/activity-tools', () => ({
  activityTools: {
    get_activity: { name: 'get_activity', description: 'Get activity' },
  },
}));

import { pageSpaceTools } from '../ai-tools';
import { driveTools } from '../../tools/drive-tools';
import { pageReadTools } from '../../tools/page-read-tools';
import { pageWriteTools } from '../../tools/page-write-tools';
import { searchTools } from '../../tools/search-tools';
import { taskManagementTools } from '../../tools/task-management-tools';
import { agentTools } from '../../tools/agent-tools';
import { agentCommunicationTools } from '../../tools/agent-communication-tools';
import { webSearchTools } from '../../tools/web-search-tools';
import { activityTools } from '../../tools/activity-tools';

describe('ai-tools', () => {
  describe('pageSpaceTools aggregation', () => {
    it('equals the merged object of all tool modules', () => {
      expect(pageSpaceTools).toEqual({
        ...driveTools,
        ...pageReadTools,
        ...pageWriteTools,
        ...searchTools,
        ...taskManagementTools,
        ...agentTools,
        ...agentCommunicationTools,
        ...webSearchTools,
        ...activityTools,
      });
    });

    it('has no key collisions between tool modules', () => {
      const moduleKeysets = [
        Object.keys(driveTools),
        Object.keys(pageReadTools),
        Object.keys(pageWriteTools),
        Object.keys(searchTools),
        Object.keys(taskManagementTools),
        Object.keys(agentTools),
        Object.keys(agentCommunicationTools),
        Object.keys(webSearchTools),
        Object.keys(activityTools),
      ];

      const allKeys = moduleKeysets.flat();
      const uniqueKeys = new Set(allKeys);

      // If there are duplicates, find them for a helpful error message
      if (uniqueKeys.size !== allKeys.length) {
        const seen = new Set<string>();
        const duplicates: string[] = [];
        for (const key of allKeys) {
          if (seen.has(key)) {
            duplicates.push(key);
          }
          seen.add(key);
        }
        throw new Error(`Tool name collisions detected: ${duplicates.join(', ')}`);
      }

      expect(uniqueKeys.size).toBe(allKeys.length);
    });

    it('has no undefined or null tools', () => {
      for (const [name, tool] of Object.entries(pageSpaceTools)) {
        if (tool === undefined || tool === null) {
          throw new Error(`Tool "${name}" is ${tool}`);
        }
      }
    });
  });
});
