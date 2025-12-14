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

import { pageSpaceTools } from '../ai-tools';

describe('ai-tools', () => {
  describe('pageSpaceTools aggregation', () => {
    it('aggregates all tools from individual modules', () => {
      expect(pageSpaceTools).toBeDefined();
      expect(typeof pageSpaceTools).toBe('object');
    });

    it('includes driveTools', () => {
      expect(pageSpaceTools.list_drives).toBeDefined();
      expect(pageSpaceTools.create_drive).toBeDefined();
      expect(pageSpaceTools.rename_drive).toBeDefined();
    });

    it('includes pageReadTools', () => {
      expect(pageSpaceTools.list_pages).toBeDefined();
      expect(pageSpaceTools.read_page).toBeDefined();
      expect(pageSpaceTools.list_trash).toBeDefined();
    });

    it('includes pageWriteTools', () => {
      expect(pageSpaceTools.replace_lines).toBeDefined();
      expect(pageSpaceTools.create_page).toBeDefined();
      expect(pageSpaceTools.rename_page).toBeDefined();
      expect(pageSpaceTools.trash).toBeDefined();
      expect(pageSpaceTools.restore).toBeDefined();
      expect(pageSpaceTools.move_page).toBeDefined();
      expect(pageSpaceTools.edit_sheet_cells).toBeDefined();
    });

    it('includes searchTools', () => {
      expect(pageSpaceTools.regex_search).toBeDefined();
      expect(pageSpaceTools.glob_search).toBeDefined();
      expect(pageSpaceTools.multi_drive_search).toBeDefined();
    });

    it('includes taskManagementTools', () => {
      expect(pageSpaceTools.update_task).toBeDefined();
    });

    it('includes agentTools', () => {
      expect(pageSpaceTools.update_agent_config).toBeDefined();
    });

    it('includes agentCommunicationTools', () => {
      expect(pageSpaceTools.list_agents).toBeDefined();
      expect(pageSpaceTools.multi_drive_list_agents).toBeDefined();
      expect(pageSpaceTools.ask_agent).toBeDefined();
    });

    it('includes webSearchTools', () => {
      expect(pageSpaceTools.web_search).toBeDefined();
    });

    it('has expected number of tools', () => {
      const toolCount = Object.keys(pageSpaceTools).length;
      // Total expected: 3 drive + 3 read + 7 write + 3 search + 1 task + 1 agent + 3 agent-comm + 1 web = 22
      expect(toolCount).toBe(22);
    });

    it('has no undefined tools', () => {
      for (const [, tool] of Object.entries(pageSpaceTools)) {
        expect(tool).toBeDefined();
        expect(tool).not.toBeNull();
      }
    });

    it('has no duplicate tool names', () => {
      const toolNames = Object.keys(pageSpaceTools);
      const uniqueNames = new Set(toolNames);
      expect(uniqueNames.size).toBe(toolNames.length);
    });
  });

  describe('tool structure', () => {
    it('each tool has a name property', () => {
      for (const [name, tool] of Object.entries(pageSpaceTools)) {
        expect((tool as { name: string }).name).toBe(name);
      }
    });

    it('each tool has a description property', () => {
      for (const [, tool] of Object.entries(pageSpaceTools)) {
        expect((tool as { description: string }).description).toBeDefined();
        expect(typeof (tool as { description: string }).description).toBe('string');
      }
    });
  });
});
