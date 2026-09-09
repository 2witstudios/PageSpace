/**
 * The label vocabulary, shared by the thread renderer and the voice call bar.
 *
 * These cases exist because this table was extracted out of a component, and an
 * extraction that changes behaviour while looking tidier is the failure mode
 * worth guarding. The field ORDER and the fact that only `query` is trimmed are
 * both faithful ports, not preferences.
 */

import { describe, expect, it } from 'vitest';
import { TOOL_NAME_MAP, describeToolCall, formatToolName } from '../tool-labels';
import { buildPageSpaceTools } from '../../core/ai-tools';

describe('formatToolName', () => {
  it('should use the curated label when there is one', () => {
    expect(formatToolName('list_drives')).toBe('Workspaces');
    expect(formatToolName('read_page')).toBe('Read Page');
  });

  it('given an uncurated tool, should title-case its name rather than show a snake_case id', () => {
    expect(formatToolName('some_new_tool')).toBe('Some New Tool');
  });

  it('should not invent a label for the empty string', () => {
    expect(formatToolName('')).toBe('');
  });
});

describe('describeToolCall', () => {
  it('should name what the call is acting on', () => {
    expect(describeToolCall('read_page', { title: 'Roadmap' })).toBe('Read Page: Roadmap');
  });

  it('given no usable arguments, should fall back to the plain label', () => {
    expect(describeToolCall('list_drives', {})).toBe('Workspaces');
    expect(describeToolCall('list_drives', undefined)).toBe('Workspaces');
    expect(describeToolCall('list_drives', 'not an object')).toBe('Workspaces');
    expect(describeToolCall('list_drives', null)).toBe('Workspaces');
  });

  it('should prefer title over every other subject, as the renderer always did', () => {
    // Order is behaviour: a call carrying both is labelled by its title.
    expect(describeToolCall('x_tool', { title: 'T', name: 'N', query: 'Q' })).toBe('X Tool: T');
    expect(describeToolCall('x_tool', { name: 'N', query: 'Q' })).toBe('X Tool: N');
  });

  it('should trim a long query and ONLY a long query', () => {
    // A query is arbitrary user text; a page title is the page's name, and
    // clipping it would make the label wrong rather than tidy.
    const long = 'a'.repeat(60);

    expect(describeToolCall('regex_search', { query: long })).toBe(
      `${formatToolName('regex_search')}: ${'a'.repeat(30)}...`,
    );
    expect(describeToolCall('read_page', { title: long })).toBe(
      `${formatToolName('read_page')}: ${long}`,
    );
  });

  it('should compose owner/repo, and place it where the renderer placed it', () => {
    expect(describeToolCall('gh_pr_list', { owner: 'o', repo: 'r' })).toContain('o/r');
    expect(describeToolCall('gh_pr_view', { owner: 'o', repo: 'r', path: 'src' })).toContain(
      'o/r/src',
    );
    // driveSlug is tried BEFORE owner/repo; repo alone is tried after.
    expect(describeToolCall('x_tool', { driveSlug: 'd', owner: 'o', repo: 'r' })).toBe('X Tool: d');
    expect(describeToolCall('x_tool', { repo: 'r' })).toBe('X Tool: r');
  });

  it('given a caller-resolved label, should keep it instead of re-deriving one', () => {
    // The thread renderer overrides integration tools from the integrations
    // registry; re-deriving here would silently throw that away.
    expect(describeToolCall('github_create_issue', { title: 'Bug' }, 'GitHub: Create Issue')).toBe(
      'GitHub: Create Issue: Bug',
    );
  });

  it('should survive arguments of the wrong type without throwing', () => {
    // These arrive as whatever the model sent. A label is never worth an
    // exception, least of all one thrown inside a reducer.
    expect(() => describeToolCall('x_tool', { title: 42, name: null, query: [] })).not.toThrow();
    expect(describeToolCall('x_tool', { title: 42, name: null, query: [] })).toBe('X Tool');
  });
});

describe('the label table against the real registry', () => {
  it('should give every registered tool a label that is not its raw name', () => {
    // Not a demand that every tool be curated — the title-case fallback is a
    // real answer. This asserts the fallback actually fires, so a tool never
    // reaches a user as `set_task_trigger`.
    for (const name of Object.keys(buildPageSpaceTools({ codeExecutionEnabled: true }))) {
      const label = formatToolName(name);
      expect(label, `${name} has no readable label`).not.toBe(name);
      expect(label).not.toContain('_');
    }
  });

  it('may label names the base registry does not contain, and that is not staleness', () => {
    // Worth pinning as a fact rather than asserting the opposite of. The
    // registry is NOT the complete set of names a label can be asked for:
    // `ask_user` is merged in per-route (`page-chat-turn.ts:1477`), and
    // `ask_agent` is a name the renderers still handle for messages already in
    // people's threads. A test demanding the table match the registry would
    // fail on both and teach the next person to delete a label that is doing
    // its job.
    const registry = new Set(Object.keys(buildPageSpaceTools({ codeExecutionEnabled: true })));
    const outsideRegistry = Object.keys(TOOL_NAME_MAP).filter((name) => !registry.has(name));

    expect(outsideRegistry.sort()).toEqual(['ask_agent', 'ask_user']);
  });
});
