/**
 * The Agents surface's URL grammar, both directions. Everything here is about
 * one property: a URL and a selection are the same fact written two ways, so
 * `parse(build(x)) === x` for every reachable selection, and a URL nobody built
 * (hand-typed, truncated, stale) still parses into something renderable rather
 * than throwing inside a router event handler.
 */
import { describe, test, expect } from 'vitest';
import {
  parseAgentSelection,
  buildAgentSelectionUrl,
  agentsBasePath,
  EMPTY_AGENT_SELECTION,
} from '../agent-selection';

describe('parseAgentSelection', () => {
  test('reads both params out of a full selection', () => {
    expect(parseAgentSelection('?agent=agent-1&c=conv-1')).toEqual({
      agentId: 'agent-1',
      conversationId: 'conv-1',
    });
  });

  test('accepts a search string with no leading question mark', () => {
    // `window.location.search` carries the `?`; a `URLSearchParams` stringified
    // back out does not. Both are the same selection.
    expect(parseAgentSelection('agent=agent-1&c=conv-1')).toEqual({
      agentId: 'agent-1',
      conversationId: 'conv-1',
    });
  });

  test('an agent with no conversation is a valid, partial selection', () => {
    // The state a user is in between clicking an agent and picking one of its
    // conversations — it must round-trip, not collapse to empty.
    expect(parseAgentSelection('?agent=agent-1')).toEqual({ agentId: 'agent-1', conversationId: null });
  });

  test('a conversation with no agent keeps the conversation', () => {
    // A global-assistant session has no agent page (`agentPageId: null` in the
    // contract), so `?c=` alone is a real address, not a broken link.
    expect(parseAgentSelection('?c=conv-1')).toEqual({ agentId: null, conversationId: 'conv-1' });
  });

  test('an empty search is the empty selection', () => {
    expect(parseAgentSelection('')).toEqual(EMPTY_AGENT_SELECTION);
    expect(parseAgentSelection('?')).toEqual(EMPTY_AGENT_SELECTION);
  });

  test('ignores params this surface does not own', () => {
    expect(parseAgentSelection('?agent=agent-1&tab=shell&utm_source=x')).toEqual({
      agentId: 'agent-1',
      conversationId: null,
    });
  });

  test('treats a blank value as absent rather than as an id of ""', () => {
    // `?agent=` survives a hand-edit or a stale bookmark; selecting the agent
    // whose id is the empty string is not a thing.
    expect(parseAgentSelection('?agent=&c=')).toEqual(EMPTY_AGENT_SELECTION);
  });

  test('decodes percent-encoded values', () => {
    expect(parseAgentSelection('?agent=a%2Fb')).toEqual({ agentId: 'a/b', conversationId: null });
  });

  test('never throws on malformed input', () => {
    // URLSearchParams is total over strings — this test pins that we keep
    // relying on it rather than growing a hand-rolled parser that isn't.
    for (const malformed of ['???', '&&&', '%', '?agent=%E0%A4%A', '=', '?=v', 'agent', '?agent']) {
      expect(() => parseAgentSelection(malformed)).not.toThrow();
    }
    expect(parseAgentSelection('%')).toEqual(EMPTY_AGENT_SELECTION);
    expect(parseAgentSelection('?agent')).toEqual(EMPTY_AGENT_SELECTION);
  });

  test('takes the first occurrence of a repeated param', () => {
    expect(parseAgentSelection('?agent=first&agent=second')).toEqual({
      agentId: 'first',
      conversationId: null,
    });
  });
});

describe('agentsBasePath', () => {
  test('global mode has no drive segment', () => {
    expect(agentsBasePath(undefined)).toBe('/dashboard/agents');
    expect(agentsBasePath(null)).toBe('/dashboard/agents');
  });

  test('drive-scoped mode puts the drive in the path', () => {
    expect(agentsBasePath('drive-1')).toBe('/dashboard/drive-1/agents');
  });
});

describe('buildAgentSelectionUrl', () => {
  test('builds the global URL with both params', () => {
    expect(buildAgentSelectionUrl({ agentId: 'agent-1', conversationId: 'conv-1' })).toBe(
      '/dashboard/agents?agent=agent-1&c=conv-1',
    );
  });

  test('builds the drive-scoped URL with both params', () => {
    expect(buildAgentSelectionUrl({ driveId: 'drive-1', agentId: 'agent-1', conversationId: 'conv-1' })).toBe(
      '/dashboard/drive-1/agents?agent=agent-1&c=conv-1',
    );
  });

  test('omits absent params rather than emitting empty ones', () => {
    // `?agent=x` and `?agent=x&c=` would parse identically, but only one of
    // them is a URL a user can read.
    expect(buildAgentSelectionUrl({ agentId: 'agent-1' })).toBe('/dashboard/agents?agent=agent-1');
    expect(buildAgentSelectionUrl({ conversationId: 'conv-1' })).toBe('/dashboard/agents?c=conv-1');
  });

  test('an empty selection is the bare surface URL, with no dangling question mark', () => {
    expect(buildAgentSelectionUrl({})).toBe('/dashboard/agents');
    expect(buildAgentSelectionUrl({ driveId: 'drive-1' })).toBe('/dashboard/drive-1/agents');
    expect(buildAgentSelectionUrl({ agentId: null, conversationId: null })).toBe('/dashboard/agents');
  });

  test('always writes agent before c', () => {
    // Param order is stable so a pushState of the same selection produces the
    // same string — otherwise identical selections would look like distinct
    // history entries.
    expect(buildAgentSelectionUrl({ conversationId: 'conv-1', agentId: 'agent-1' })).toBe(
      '/dashboard/agents?agent=agent-1&c=conv-1',
    );
  });

  test('encodes values that would otherwise break the query string', () => {
    expect(buildAgentSelectionUrl({ agentId: 'a b&c=d' })).toBe('/dashboard/agents?agent=a+b%26c%3Dd');
    expect(buildAgentSelectionUrl({ driveId: 'drive one' })).toBe('/dashboard/drive%20one/agents');
  });

  test('round-trips every selection through parse', () => {
    const selections = [
      { agentId: 'agent-1', conversationId: 'conv-1' },
      { agentId: 'agent-1', conversationId: null },
      { agentId: null, conversationId: 'conv-1' },
      { agentId: null, conversationId: null },
      { agentId: 'a/b c', conversationId: 'x&y' },
    ];
    for (const selection of selections) {
      const url = buildAgentSelectionUrl(selection);
      const search = url.includes('?') ? url.slice(url.indexOf('?')) : '';
      expect(parseAgentSelection(search)).toEqual(selection);
    }
  });
});
