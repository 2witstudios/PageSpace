/**
 * What a bound pane renders is a DECISION, not a default: an explicit
 * `kind` on the pane's scope wins outright, and only a kind-less (pre-#2166)
 * binding falls back to resolving the session's agentType from the SWR list —
 * where "the list hasn't answered yet" must yield `loading`, never a mounted
 * Xterm that cold-starts a PTY for a session that turns out to be a chat.
 */
import { describe, test } from 'vitest';
import { assert } from '@/stores/__tests__/riteway';
import { resolvePaneSurface, agentTypeLabelOf } from './pane-surface';

/** The workspace's checkout — the scope its SWR session list is fetched at. */
const NODE = { projectName: 'app', branchName: 'main' };

const chatRow = { id: 'row-chat', name: 'pagespace-a1', agentType: 'pagespace', createdAt: '' };
const ptyRow = { id: 'row-pty', name: 'shell-b2', agentType: 'shell', createdAt: '' };

describe('resolvePaneSurface', () => {
  test('an explicit chat kind renders chat, carrying the row id the list resolved', () => {
    assert({
      given: 'a pane bound with kind "chat" whose session row is in the list',
      should: 'be a chat surface addressing that row — the row id IS the conversation id (Phase 4)',
      actual: resolvePaneSurface({
        scope: { ...NODE, name: 'pagespace-a1', kind: 'chat' },
        workspaceScope: NODE,
        agentTerminals: [chatRow],
        isLoading: false,
      }),
      expected: { surface: 'chat', terminalId: 'row-chat' },
    });
  });

  test('a chat-kind pane whose row has not arrived yet is chat WITHOUT a row id — never a PTY', () => {
    assert({
      given: 'kind "chat" while the session list is still loading',
      should: 'stay a chat surface with a null terminalId (the caller shows loading) rather than fall back to a terminal',
      actual: resolvePaneSurface({
        scope: { ...NODE, name: 'pagespace-a1', kind: 'chat' },
        workspaceScope: NODE,
        agentTerminals: [],
        isLoading: true,
      }),
      expected: { surface: 'chat', terminalId: null },
    });
  });

  test('an explicit terminal kind is a terminal, no list consulted', () => {
    assert({
      given: 'kind "terminal" while the list is still loading',
      should: 'be a terminal immediately — an explicit binding never waits on the list',
      actual: resolvePaneSurface({
        scope: { ...NODE, name: 'shell-b2', kind: 'terminal' },
        workspaceScope: NODE,
        agentTerminals: [],
        isLoading: true,
      }),
      expected: { surface: 'terminal' },
    });
  });

  test('no kind hint + the list resolving the name to a chat agent type renders chat', () => {
    assert({
      given: 'a kind-less scope whose name the loaded list maps to agentType "pagespace"',
      should: 'resolve to the chat surface, with the row id',
      actual: resolvePaneSurface({
        scope: { ...NODE, name: 'pagespace-a1' },
        workspaceScope: NODE,
        agentTerminals: [chatRow],
        isLoading: false,
      }),
      expected: { surface: 'chat', terminalId: 'row-chat' },
    });
  });

  test('no kind hint + the list resolving the name to a PTY agent type renders a terminal', () => {
    assert({
      given: 'a kind-less scope whose name the loaded list maps to agentType "shell"',
      should: 'resolve to a terminal',
      actual: resolvePaneSurface({
        scope: { ...NODE, name: 'shell-b2' },
        workspaceScope: NODE,
        agentTerminals: [ptyRow],
        isLoading: false,
      }),
      expected: { surface: 'terminal' },
    });
  });

  test('no kind hint while the list is loading is LOADING — never mount Xterm for a maybe-chat session', () => {
    assert({
      given: 'a kind-less scope and a list that has not answered yet',
      should:
        'hold at loading — mounting Xterm now would cold-start a PTY (and register a viewer) for a session that may turn out to be a chat',
      actual: resolvePaneSurface({
        scope: { ...NODE, name: 'pagespace-a1' },
        workspaceScope: NODE,
        agentTerminals: [],
        isLoading: true,
      }),
      expected: { surface: 'loading' },
    });
  });

  test('no kind hint, list loaded, name not found: a terminal — every pre-kind binding was a PTY', () => {
    assert({
      given: 'a kind-less scope the loaded list does not contain (a stale or killed session)',
      should: 'fall back to a terminal — omitted kind predates chat panes, so the legacy reading is the safe one',
      actual: resolvePaneSurface({
        scope: { ...NODE, name: 'gone' },
        workspaceScope: NODE,
        agentTerminals: [chatRow],
        isLoading: false,
      }),
      expected: { surface: 'terminal' },
    });
  });

  test('a retired agentType the registry no longer knows resolves to a terminal, not a crash', () => {
    assert({
      given: 'a row whose agentType is a since-removed AGENT_LAUNCH_SPECS entry',
      should: 'treat it as a PTY — the DB can hold rows from retired types (see AgentTerminal.agentType\'s doc)',
      actual: resolvePaneSurface({
        scope: { ...NODE, name: 'old-cli' },
        workspaceScope: NODE,
        agentTerminals: [{ id: 'row-old', name: 'old-cli', agentType: 'pagespace-cli' }],
        isLoading: false,
      }),
      expected: { surface: 'terminal' },
    });
  });

  test('a pane at a FOREIGN checkout never resolves against this workspace\'s list', () => {
    assert({
      given: 'a kind-less pane whose node scope differs from the workspace\'s (a restored server layout), sharing a name with a chat row in the list',
      should:
        'be a terminal immediately, even mid-load — the workspace-scoped list says nothing about another checkout\'s sessions, and a same-name match across scopes would be a different session',
      actual: resolvePaneSurface({
        scope: { name: 'pagespace-a1' },
        workspaceScope: NODE,
        agentTerminals: [chatRow],
        isLoading: true,
      }),
      expected: { surface: 'terminal' },
    });
  });
});

describe('agentTypeLabelOf', () => {
  test('the chat agent presents as "Agent", the PTY type as "Shell"', () => {
    assert({
      given: 'every pickable agent type',
      should: 'label pagespace "Agent" — agents and chats are one thing, and PageSpace is the assumed context — and shell "Shell"',
      actual: {
        pagespace: agentTypeLabelOf('pagespace'),
        shell: agentTypeLabelOf('shell'),
      },
      expected: {
        pagespace: 'Agent',
        shell: 'Shell',
      },
    });
  });
});
