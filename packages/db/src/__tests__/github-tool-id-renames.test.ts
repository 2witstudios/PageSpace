import { describe, it, expect } from 'vitest';
import { GITHUB_TOOL_ID_RENAMES, remapToolIds } from '../github-tool-id-renames';

describe('remapToolIds', () => {
  it('given an array with renamed ids, should rewrite them to the new ids', () => {
    const result = remapToolIds(['get_issues', 'get_pr_diff', 'list_repos']);
    expect(result.changed).toBe(true);
    expect(result.value).toEqual(['list_issues', 'list_pr_files', 'list_repos']);
  });

  it('given an array with no renamed ids, should return the original reference unchanged', () => {
    const input = ['list_repos', 'get_repo'];
    const result = remapToolIds(input);
    expect(result.changed).toBe(false);
    expect(result.value).toBe(input);
  });

  it('given null (all-tools grant), should pass through unchanged', () => {
    expect(remapToolIds(null)).toEqual({ value: null, changed: false });
  });

  it('given a non-array value, should pass through unchanged', () => {
    expect(remapToolIds('not-an-array')).toEqual({ value: 'not-an-array', changed: false });
  });

  it('given every old id in the map, should map to a distinct list_ id', () => {
    const news = Object.values(GITHUB_TOOL_ID_RENAMES);
    expect(new Set(news).size).toBe(news.length);
    for (const [, newId] of Object.entries(GITHUB_TOOL_ID_RENAMES)) {
      expect(newId.startsWith('list_')).toBe(true);
    }
  });
});
