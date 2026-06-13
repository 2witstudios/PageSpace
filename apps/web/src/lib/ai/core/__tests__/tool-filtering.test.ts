import { describe, it, expect } from 'vitest';
import {
  buildPageAITools,
  filterToolsForReadOnly,
  filterToolsForWebSearch,
  isWebSearchTool,
  isWriteTool,
} from '../tool-filtering';

const baseline = {
  // read tools
  list_pages: 'list_pages',
  read_page: 'read_page',
  // write tools
  create_page: 'create_page',
  trash_page: 'trash_page',
  // web search
  web_search: 'web_search',
} as const;

describe('buildPageAITools', () => {
  it('returns the full baseline when web search is on and read-only is off', () => {
    const result = buildPageAITools(baseline, {
      isReadOnly: false,
      webSearchEnabled: true,
    });

    expect(Object.keys(result).sort()).toEqual(
      ['create_page', 'list_pages', 'read_page', 'trash_page', 'web_search']
    );
  });

  it('strips web_search when webSearchEnabled is false', () => {
    const result = buildPageAITools(baseline, {
      isReadOnly: false,
      webSearchEnabled: false,
    });

    expect(result.web_search).toBeUndefined();
    expect(result.read_page).toBe('read_page');
    expect(result.create_page).toBe('create_page');
  });

  it('strips write tools when isReadOnly is true', () => {
    const result = buildPageAITools(baseline, {
      isReadOnly: true,
      webSearchEnabled: true,
    });

    expect(result.create_page).toBeUndefined();
    expect(result.trash_page).toBeUndefined();
    expect(result.read_page).toBe('read_page');
    expect(result.web_search).toBe('web_search');
  });

  it('strips both write tools and web_search when both flags are off', () => {
    const result = buildPageAITools(baseline, {
      isReadOnly: true,
      webSearchEnabled: false,
    });

    expect(Object.keys(result).sort()).toEqual(['list_pages', 'read_page']);
  });

  it('returns the baseline regardless of any prior agent enabledTools state', () => {
    // The baseline IS the source of truth. The route used to filter against
    // page.enabledTools before this helper ran; this test pins the new
    // contract that no such gate exists here.
    const result = buildPageAITools(baseline, {
      isReadOnly: false,
      webSearchEnabled: true,
    });

    expect(result.web_search).toBe('web_search');
  });
});

describe('filterToolsForReadOnly', () => {
  it('returns input unchanged when isReadOnly is false', () => {
    const result = filterToolsForReadOnly(baseline, false);
    expect(result).toEqual(baseline);
  });

  it('removes write tools when isReadOnly is true', () => {
    const result = filterToolsForReadOnly(baseline, true);
    expect(result.create_page).toBeUndefined();
    expect(result.trash_page).toBeUndefined();
    expect(result.read_page).toBe('read_page');
  });
});

describe('filterToolsForWebSearch', () => {
  it('returns input unchanged when webSearchEnabled is true', () => {
    const result = filterToolsForWebSearch(baseline, true);
    expect(result).toEqual(baseline);
  });

  it('removes web_search when webSearchEnabled is false', () => {
    const result = filterToolsForWebSearch(baseline, false);
    expect(result.web_search).toBeUndefined();
    expect(result.read_page).toBe('read_page');
  });
});

describe('isWriteTool / isWebSearchTool predicates', () => {
  it('classifies write tools correctly', () => {
    expect(isWriteTool('create_page')).toBe(true);
    expect(isWriteTool('send_channel_message')).toBe(true);
    expect(isWriteTool('delete_channel_message')).toBe(true);
    expect(isWriteTool('read_page')).toBe(false);
    expect(isWriteTool('web_search')).toBe(false);
  });

  it('classifies explicit per-entity trash/restore tools as writes', () => {
    expect(isWriteTool('trash_page')).toBe(true);
    expect(isWriteTool('trash_drive')).toBe(true);
    expect(isWriteTool('restore_page')).toBe(true);
    expect(isWriteTool('restore_drive')).toBe(true);
  });

  it('classifies web search tools correctly', () => {
    expect(isWebSearchTool('web_search')).toBe(true);
    expect(isWebSearchTool('read_page')).toBe(false);
    expect(isWebSearchTool('create_page')).toBe(false);
  });

  it('classifies insert_content as a write tool', () => {
    expect(isWriteTool('insert_content')).toBe(true);
  });

  it('excludes insert_content in read-only mode', () => {
    const tools = {
      insert_content: 'w',
      read_page: 'r',
    };
    const filtered = filterToolsForReadOnly(tools, true);
    expect(filtered).not.toHaveProperty('insert_content');
    expect(filtered).toHaveProperty('read_page');
  });

  it('classifies set_home_page as a write tool and excludes it in read-only mode', () => {
    expect(isWriteTool('set_home_page')).toBe(true);
    const tools = { set_home_page: 'w', list_pages: 'r' };
    const filtered = filterToolsForReadOnly(tools, true);
    expect(filtered).not.toHaveProperty('set_home_page');
    expect(filtered).toHaveProperty('list_pages');
  });

  it('classifies workflow tools: writes are write tools, list is read', () => {
    expect(isWriteTool('create_workflow')).toBe(true);
    expect(isWriteTool('update_workflow')).toBe(true);
    expect(isWriteTool('delete_workflow')).toBe(true);
    expect(isWriteTool('list_workflows')).toBe(false);
    expect(isWriteTool('set_calendar_trigger')).toBe(true);
    expect(isWriteTool('delete_calendar_trigger')).toBe(true);
    expect(isWriteTool('set_task_trigger')).toBe(true);
    expect(isWriteTool('delete_task_trigger')).toBe(true);
  });

  it('excludes workflow write tools in read-only mode but keeps list_workflows', () => {
    const tools = {
      list_workflows: 'r',
      create_workflow: 'w',
      update_workflow: 'w',
      delete_workflow: 'w',
    };
    const filtered = filterToolsForReadOnly(tools, true);
    expect(filtered).toHaveProperty('list_workflows');
    expect(filtered).not.toHaveProperty('create_workflow');
    expect(filtered).not.toHaveProperty('update_workflow');
    expect(filtered).not.toHaveProperty('delete_workflow');
  });

  it('excludes trigger write tools in read-only mode', () => {
    const tools = {
      set_calendar_trigger: 'w',
      delete_calendar_trigger: 'w',
      set_task_trigger: 'w',
      delete_task_trigger: 'w',
      list_calendar_events: 'r',
    };
    const filtered = filterToolsForReadOnly(tools, true);
    expect(filtered).not.toHaveProperty('set_calendar_trigger');
    expect(filtered).not.toHaveProperty('delete_calendar_trigger');
    expect(filtered).not.toHaveProperty('set_task_trigger');
    expect(filtered).not.toHaveProperty('delete_task_trigger');
    expect(filtered).toHaveProperty('list_calendar_events');
  });
});
