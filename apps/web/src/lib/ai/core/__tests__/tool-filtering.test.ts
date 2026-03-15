import { describe, it, expect } from 'vitest';

import {
  isWriteTool,
  filterToolsForReadOnly,
  isWebSearchTool,
  filterToolsForWebSearch,
  filterTools,
  getToolsSummary,
} from '../tool-filtering';

describe('tool-filtering', () => {
  describe('isWriteTool', () => {
    it('should return true for create_page', () => {
      expect(isWriteTool('create_page')).toBe(true);
    });

    it('should return true for rename_page', () => {
      expect(isWriteTool('rename_page')).toBe(true);
    });

    it('should return true for replace_lines', () => {
      expect(isWriteTool('replace_lines')).toBe(true);
    });

    it('should return true for move_page', () => {
      expect(isWriteTool('move_page')).toBe(true);
    });

    it('should return true for edit_sheet_cells', () => {
      expect(isWriteTool('edit_sheet_cells')).toBe(true);
    });

    it('should return true for create_drive', () => {
      expect(isWriteTool('create_drive')).toBe(true);
    });

    it('should return true for rename_drive', () => {
      expect(isWriteTool('rename_drive')).toBe(true);
    });

    it('should return true for trash', () => {
      expect(isWriteTool('trash')).toBe(true);
    });

    it('should return true for restore', () => {
      expect(isWriteTool('restore')).toBe(true);
    });

    it('should return true for update_agent_config', () => {
      expect(isWriteTool('update_agent_config')).toBe(true);
    });

    it('should return true for update_task', () => {
      expect(isWriteTool('update_task')).toBe(true);
    });

    it('should return true for send_channel_message', () => {
      expect(isWriteTool('send_channel_message')).toBe(true);
    });

    it('should return false for read_page', () => {
      expect(isWriteTool('read_page')).toBe(false);
    });

    it('should return false for list_pages', () => {
      expect(isWriteTool('list_pages')).toBe(false);
    });

    it('should return false for list_drives', () => {
      expect(isWriteTool('list_drives')).toBe(false);
    });

    it('should return false for web_search', () => {
      expect(isWriteTool('web_search')).toBe(false);
    });

    it('should return false for unknown tool name', () => {
      expect(isWriteTool('some_unknown_tool')).toBe(false);
    });
  });

  describe('filterToolsForReadOnly', () => {
    const tools = {
      read_page: { description: 'Read a page' },
      list_pages: { description: 'List pages' },
      create_page: { description: 'Create a page' },
      rename_page: { description: 'Rename a page' },
      trash: { description: 'Trash an item' },
    };

    it('should return all tools when not in read-only mode', () => {
      const result = filterToolsForReadOnly(tools, false);
      expect(result).toEqual(tools);
    });

    it('should remove write tools when in read-only mode', () => {
      const result = filterToolsForReadOnly(tools, true);
      expect(result).toHaveProperty('read_page');
      expect(result).toHaveProperty('list_pages');
      expect(result).not.toHaveProperty('create_page');
      expect(result).not.toHaveProperty('rename_page');
      expect(result).not.toHaveProperty('trash');
    });

    it('should return empty object when all tools are write tools and in read-only mode', () => {
      const writeOnlyTools = {
        create_page: { description: 'Create' },
        rename_page: { description: 'Rename' },
      };
      const result = filterToolsForReadOnly(writeOnlyTools, true);
      expect(Object.keys(result)).toHaveLength(0);
    });

    it('should handle empty tools object', () => {
      const result = filterToolsForReadOnly({}, true);
      expect(result).toEqual({});
    });
  });

  describe('isWebSearchTool', () => {
    it('should return true for web_search', () => {
      expect(isWebSearchTool('web_search')).toBe(true);
    });

    it('should return false for read_page', () => {
      expect(isWebSearchTool('read_page')).toBe(false);
    });

    it('should return false for unknown tool', () => {
      expect(isWebSearchTool('unknown')).toBe(false);
    });
  });

  describe('filterToolsForWebSearch', () => {
    const tools = {
      read_page: { description: 'Read a page' },
      web_search: { description: 'Web search' },
      list_pages: { description: 'List pages' },
    };

    it('should return all tools when web search is enabled', () => {
      const result = filterToolsForWebSearch(tools, true);
      expect(result).toEqual(tools);
    });

    it('should remove web_search when web search is disabled', () => {
      const result = filterToolsForWebSearch(tools, false);
      expect(result).toHaveProperty('read_page');
      expect(result).toHaveProperty('list_pages');
      expect(result).not.toHaveProperty('web_search');
    });
  });

  describe('filterTools', () => {
    const tools = {
      read_page: { description: 'Read a page' },
      list_pages: { description: 'List pages' },
      create_page: { description: 'Create a page' },
      web_search: { description: 'Web search' },
    };

    it('should return all tools when no restrictions', () => {
      const result = filterTools(tools, {});
      expect(result).toEqual(tools);
    });

    it('should filter write tools when isReadOnly is true', () => {
      const result = filterTools(tools, { isReadOnly: true });
      expect(result).not.toHaveProperty('create_page');
      expect(result).toHaveProperty('read_page');
      expect(result).toHaveProperty('web_search');
    });

    it('should filter web search when webSearchEnabled is false', () => {
      const result = filterTools(tools, { webSearchEnabled: false });
      expect(result).not.toHaveProperty('web_search');
      expect(result).toHaveProperty('create_page');
    });

    it('should apply both filters simultaneously', () => {
      const result = filterTools(tools, { isReadOnly: true, webSearchEnabled: false });
      expect(result).not.toHaveProperty('create_page');
      expect(result).not.toHaveProperty('web_search');
      expect(result).toHaveProperty('read_page');
      expect(result).toHaveProperty('list_pages');
    });

    it('should not filter write tools when isReadOnly is false', () => {
      const result = filterTools(tools, { isReadOnly: false });
      expect(result).toHaveProperty('create_page');
    });

    it('should not filter web search when webSearchEnabled is true', () => {
      const result = filterTools(tools, { webSearchEnabled: true });
      expect(result).toHaveProperty('web_search');
    });
  });

  describe('getToolsSummary', () => {
    it('should return all tools as allowed when not read-only and web search enabled', () => {
      const summary = getToolsSummary(false, true);
      expect(summary.denied).toHaveLength(0);
      expect(summary.allowed.length).toBeGreaterThan(0);
    });

    it('should include web_search in allowed when webSearchEnabled is true', () => {
      const summary = getToolsSummary(false, true);
      expect(summary.allowed).toContain('web_search');
    });

    it('should move web_search to denied when webSearchEnabled is false', () => {
      const summary = getToolsSummary(false, false);
      expect(summary.denied).toContain('web_search');
      expect(summary.allowed).not.toContain('web_search');
    });

    it('should move write tools to denied when isReadOnly is true', () => {
      const summary = getToolsSummary(true, true);
      expect(summary.denied).toContain('create_page');
      expect(summary.denied).toContain('rename_page');
      expect(summary.allowed).not.toContain('create_page');
    });

    it('should keep read tools in allowed when isReadOnly is true', () => {
      const summary = getToolsSummary(true, true);
      expect(summary.allowed).toContain('read_page');
      expect(summary.allowed).toContain('list_pages');
    });

    it('should use webSearchEnabled default of true when not provided', () => {
      const summary = getToolsSummary(false);
      expect(summary.allowed).toContain('web_search');
    });

    it('should deny both write tools and web_search when both restrictions active', () => {
      const summary = getToolsSummary(true, false);
      expect(summary.denied).toContain('create_page');
      expect(summary.denied).toContain('web_search');
    });
  });
});
