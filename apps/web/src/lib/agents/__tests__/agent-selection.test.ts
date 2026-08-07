/**
 * The Agents surface's URL grammar, both directions. Everything here is about
 * one property: a URL and a selection are the same fact written two ways, so
 * `parse(build(x)) === x` for every reachable selection, and a URL nobody built
 * (hand-typed, truncated, stale) still parses into something renderable rather
 * than throwing inside a router event handler.
 *
 * The grammar is session-first: `session` addresses the workspace, `c` the
 * conversation inside it, and `agent` the conversation's agent page.
 */
import { describe, test, expect } from 'vitest';
import {
  parseAgentSelection,
  buildAgentSelectionUrl,
  agentsBasePath,
  EMPTY_AGENT_SELECTION,
} from '../agent-selection';

describe('parseAgentSelection', () => {
  test('reads all three params out of a full selection', () => {
    expect(parseAgentSelection('?workspace=ses-1&c=conv-1&agent=agent-1')).toEqual({
      sessionId: 'ses-1',
      conversationId: 'conv-1',
      agentId: 'agent-1',
    });
  });

  test('accepts a search string with no leading question mark', () => {
    // `window.location.search` carries the `?`; a `URLSearchParams` stringified
    // back out does not. Both are the same selection.
    expect(parseAgentSelection('workspace=ses-1&c=conv-1&agent=agent-1')).toEqual({
      sessionId: 'ses-1',
      conversationId: 'conv-1',
      agentId: 'agent-1',
    });
  });

  test('a session with no conversation is a valid, partial selection', () => {
    // The degenerate deep-link state (a hand-trimmed URL) — it must round-trip,
    // not collapse to empty.
    expect(parseAgentSelection('?workspace=ses-1')).toEqual({
      sessionId: 'ses-1',
      conversationId: null,
      agentId: null,
    });
  });

  test('a conversation with no agent keeps the conversation', () => {
    // A global-assistant conversation has no agent page (`agentPageId: null` in
    // the contract), so `?workspace=&c=` without `agent` is a real address.
    expect(parseAgentSelection('?workspace=ses-1&c=conv-1')).toEqual({
      sessionId: 'ses-1',
      conversationId: 'conv-1',
      agentId: null,
    });
  });

  test('an empty search is the empty selection', () => {
    expect(parseAgentSelection('')).toEqual(EMPTY_AGENT_SELECTION);
    expect(parseAgentSelection('?')).toEqual(EMPTY_AGENT_SELECTION);
  });

  test('ignores params this surface does not own', () => {
    expect(parseAgentSelection('?workspace=ses-1&tab=shell&utm_source=x')).toEqual({
      sessionId: 'ses-1',
      conversationId: null,
      agentId: null,
    });
  });

  test('treats a blank value as absent rather than as an id of ""', () => {
    // `?workspace=` survives a hand-edit or a stale bookmark; selecting the
    // session whose id is the empty string is not a thing.
    expect(parseAgentSelection('?workspace=&agent=&c=')).toEqual(EMPTY_AGENT_SELECTION);
  });

  test('decodes percent-encoded values', () => {
    expect(parseAgentSelection('?workspace=a%2Fb')).toEqual({
      sessionId: 'a/b',
      conversationId: null,
      agentId: null,
    });
  });

  test('never throws on malformed input', () => {
    // URLSearchParams is total over strings — this test pins that we keep
    // relying on it rather than growing a hand-rolled parser that isn't.
    for (const malformed of ['???', '&&&', '%', '?workspace=%E0%A4%A', '=', '?=v', 'session', '?session']) {
      expect(() => parseAgentSelection(malformed)).not.toThrow();
    }
    expect(parseAgentSelection('%')).toEqual(EMPTY_AGENT_SELECTION);
    expect(parseAgentSelection('?session')).toEqual(EMPTY_AGENT_SELECTION);
  });

  test('takes the first occurrence of a repeated param', () => {
    expect(parseAgentSelection('?workspace=first&workspace=second')).toEqual({
      sessionId: 'first',
      conversationId: null,
      agentId: null,
    });
  });

  // ROLLING-DEPLOY COMPAT, one release only (agent_sessions → agent_workspaces).
  // Every bookmark, shared link and restored tab minted before the rename spells
  // the workspace `?session=`; dropping it would silently deselect them all.
  test('still accepts the pre-rename ?session= spelling', () => {
    expect(parseAgentSelection('?session=ses-1&c=conv-1&agent=agent-1')).toEqual({
      sessionId: 'ses-1',
      conversationId: 'conv-1',
      agentId: 'agent-1',
    });
  });

  test('prefers ?workspace= when a link carries both spellings', () => {
    expect(parseAgentSelection('?session=old&workspace=new')).toEqual({
      sessionId: 'new',
      conversationId: null,
      agentId: null,
    });
  });

  test('falls back to ?session= when ?workspace= is present but blank', () => {
    expect(parseAgentSelection('?workspace=&session=ses-1')).toEqual({
      sessionId: 'ses-1',
      conversationId: null,
      agentId: null,
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
  test('builds the global URL with all params', () => {
    expect(
      buildAgentSelectionUrl({ sessionId: 'ses-1', conversationId: 'conv-1', agentId: 'agent-1' }),
    ).toBe('/dashboard/agents?workspace=ses-1&c=conv-1&agent=agent-1');
  });

  test('builds the drive-scoped URL with all params', () => {
    expect(
      buildAgentSelectionUrl({
        driveId: 'drive-1',
        sessionId: 'ses-1',
        conversationId: 'conv-1',
        agentId: 'agent-1',
      }),
    ).toBe('/dashboard/drive-1/agents?workspace=ses-1&c=conv-1&agent=agent-1');
  });

  test('omits absent params rather than emitting empty ones', () => {
    // `?workspace=x` and `?workspace=x&c=` would parse identically, but only one of
    // them is a URL a user can read.
    expect(buildAgentSelectionUrl({ sessionId: 'ses-1' })).toBe('/dashboard/agents?workspace=ses-1');
    expect(buildAgentSelectionUrl({ conversationId: 'conv-1' })).toBe('/dashboard/agents?c=conv-1');
    expect(buildAgentSelectionUrl({ agentId: 'agent-1' })).toBe('/dashboard/agents?agent=agent-1');
  });

  test('an empty selection is the bare surface URL, with no dangling question mark', () => {
    expect(buildAgentSelectionUrl({})).toBe('/dashboard/agents');
    expect(buildAgentSelectionUrl({ driveId: 'drive-1' })).toBe('/dashboard/drive-1/agents');
    expect(
      buildAgentSelectionUrl({ sessionId: null, agentId: null, conversationId: null }),
    ).toBe('/dashboard/agents');
  });

  test('always writes session, then c, then agent', () => {
    // Param order is stable so a pushState of the same selection produces the
    // same string — otherwise identical selections would look like distinct
    // history entries.
    expect(
      buildAgentSelectionUrl({ agentId: 'agent-1', conversationId: 'conv-1', sessionId: 'ses-1' }),
    ).toBe('/dashboard/agents?workspace=ses-1&c=conv-1&agent=agent-1');
  });

  test('encodes values that would otherwise break the query string', () => {
    expect(buildAgentSelectionUrl({ sessionId: 'a b&c=d' })).toBe('/dashboard/agents?workspace=a+b%26c%3Dd');
    expect(buildAgentSelectionUrl({ driveId: 'drive one' })).toBe('/dashboard/drive%20one/agents');
  });

  test('round-trips every selection through parse', () => {
    const selections = [
      { sessionId: 'ses-1', conversationId: 'conv-1', agentId: 'agent-1' },
      { sessionId: 'ses-1', conversationId: null, agentId: null },
      { sessionId: 'ses-1', conversationId: 'conv-1', agentId: null },
      { sessionId: null, conversationId: null, agentId: null },
      { sessionId: 'a/b c', conversationId: 'x&y', agentId: 'p+q' },
    ];
    for (const selection of selections) {
      const url = buildAgentSelectionUrl(selection);
      const search = url.includes('?') ? url.slice(url.indexOf('?')) : '';
      expect(parseAgentSelection(search)).toEqual(selection);
    }
  });
});
