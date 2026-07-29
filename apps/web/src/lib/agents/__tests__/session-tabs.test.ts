/**
 * The session view's tab descriptors.
 *
 * This is the pane escape hatch made structural rather than aspirational: v1
 * renders these as tabs, a later version renders the SAME descriptors as
 * resizable panes, and neither container decides what the leaves are. So the
 * ordering and identity rules are tested here, where they'll outlive the tab
 * container that currently consumes them.
 */
import { describe, test, expect } from 'vitest';
import type { ShellDTO } from '@pagespace/lib/agent-sessions/contract';
import { resolveSessionTabs, CHAT_TAB_ID } from '../session-tabs';

const shell = (overrides: Partial<ShellDTO> = {}): ShellDTO => ({
  shellId: 'shell-a',
  sessionId: 'conv-1',
  ownerId: 'user-1',
  name: 'shell-1',
  agentType: 'shell',
  command: null,
  createdAt: '2026-07-28T00:00:00.000Z',
  ...overrides,
});

describe('resolveSessionTabs', () => {
  test('chat is always present and always first', () => {
    // The conversation IS the session; there is no state in which a session has
    // no chat surface, so chat is not derived from anything.
    expect(resolveSessionTabs([])).toEqual([{ id: CHAT_TAB_ID, kind: 'chat', label: 'Chat' }]);
    const tabs = resolveSessionTabs([shell()]);
    expect(tabs[0]).toEqual({ id: CHAT_TAB_ID, kind: 'chat', label: 'Chat' });
  });

  test('a shell tab is derived from its shellId and labelled by its name', () => {
    // Ids address, names label — the tab's identity must not move when a shell
    // is renamed, or the container would tear down a live PTY over a label edit.
    // The tab id is NAMESPACED (`shell:`) rather than the bare shellId so that no
    // shell can ever collide with the reserved chat tab.
    const tabs = resolveSessionTabs([shell({ shellId: 'sh-1', name: 'build' })]);
    expect(tabs[1]).toEqual({ id: 'shell:sh-1', kind: 'shell', label: 'build', shellId: 'sh-1' });
  });

  test('orders shells oldest first', () => {
    const tabs = resolveSessionTabs([
      shell({ shellId: 'sh-2', name: 'shell-2', createdAt: '2026-07-28T02:00:00.000Z' }),
      shell({ shellId: 'sh-1', name: 'shell-1', createdAt: '2026-07-28T01:00:00.000Z' }),
    ]);
    expect(tabs.map((t) => t.id)).toEqual([CHAT_TAB_ID, 'shell:sh-1', 'shell:sh-2']);
  });

  test('breaks a createdAt tie by shellId so the order is total', () => {
    // Two shells opened in the same millisecond must not swap places between
    // renders — an unstable order would reshuffle live PTY panes.
    const tabs = resolveSessionTabs([
      shell({ shellId: 'sh-b', createdAt: '2026-07-28T01:00:00.000Z' }),
      shell({ shellId: 'sh-a', createdAt: '2026-07-28T01:00:00.000Z' }),
    ]);
    expect(tabs.map((t) => t.shellId)).toEqual([undefined, 'sh-a', 'sh-b']);
  });

  test('sorts unparseable timestamps to the end without throwing', () => {
    const tabs = resolveSessionTabs([
      shell({ shellId: 'sh-bad', createdAt: 'not-a-date' }),
      shell({ shellId: 'sh-ok', createdAt: '2026-07-28T01:00:00.000Z' }),
    ]);
    expect(tabs.map((t) => t.shellId)).toEqual([undefined, 'sh-ok', 'sh-bad']);
  });

  test('drops duplicate shellIds, keeping the first', () => {
    // An optimistic add landing next to its own server echo would otherwise
    // mount the same PTY twice.
    const tabs = resolveSessionTabs([
      shell({ shellId: 'sh-1', name: 'first' }),
      shell({ shellId: 'sh-1', name: 'echo' }),
    ]);
    expect(tabs).toHaveLength(2);
    expect(tabs[1].label).toBe('first');
  });

  test('falls back to a readable label when a shell has no name', () => {
    // A tab with an empty title is unclickable in practice; the id is never
    // pretty but it is always there.
    const tabs = resolveSessionTabs([shell({ shellId: 'sh-1', name: '' })]);
    expect(tabs[1].label).toBe('sh-1');
  });

  test('ignores rows with no shellId', () => {
    const tabs = resolveSessionTabs([shell({ shellId: '' }), shell({ shellId: 'sh-1' })]);
    expect(tabs.map((t) => t.id)).toEqual([CHAT_TAB_ID, 'shell:sh-1']);
  });

  test('tolerates an absent list', () => {
    // The shells hook has no data on first render; that is a session with a chat
    // tab, not an empty view.
    expect(resolveSessionTabs(undefined)).toEqual([{ id: CHAT_TAB_ID, kind: 'chat', label: 'Chat' }]);
  });

  test('does not mutate its input', () => {
    const shells = [
      shell({ shellId: 'sh-2', createdAt: '2026-07-28T02:00:00.000Z' }),
      shell({ shellId: 'sh-1', createdAt: '2026-07-28T01:00:00.000Z' }),
    ];
    resolveSessionTabs(shells);
    expect(shells.map((s) => s.shellId)).toEqual(['sh-2', 'sh-1']);
  });

  test('a shell whose id is literally "chat" still cannot collide with the chat tab', () => {
    // Why the namespace exists. cuid2 will never mint "chat", but the container
    // keys on these ids, and "improbable" is not the same as "impossible".
    const tabs = resolveSessionTabs([
      shell({ shellId: 'sh-1' }),
      shell({ shellId: CHAT_TAB_ID, name: 'chat-named-shell' }),
    ]);
    expect(new Set(tabs.map((t) => t.id)).size).toBe(tabs.length);
    expect(tabs.map((t) => t.id)).toContain(`shell:${CHAT_TAB_ID}`);
  });
});
