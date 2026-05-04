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
  trash: 'trash',
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
      ['create_page', 'list_pages', 'read_page', 'trash', 'web_search']
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
    expect(result.trash).toBeUndefined();
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
    expect(result.trash).toBeUndefined();
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
    expect(isWriteTool('trash')).toBe(true);
    expect(isWriteTool('read_page')).toBe(false);
    expect(isWriteTool('web_search')).toBe(false);
  });

  it('classifies web search tools correctly', () => {
    expect(isWebSearchTool('web_search')).toBe(true);
    expect(isWebSearchTool('read_page')).toBe(false);
    expect(isWebSearchTool('create_page')).toBe(false);
  });
});
