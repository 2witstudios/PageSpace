/**
 * The pane's render branch as data. The rule worth pinning is the negative one:
 * a pane never speculates its way into a terminal, because mounting one opens a
 * PTY stream and registers a viewer server-side.
 */
import { describe, it, expect } from 'vitest';
import type { PaneScope } from '@pagespace/lib/agent-sessions/contract';
import { resolvePaneSurface } from '../pane-surface';

const chat = (targetId: string | null, agentPageId: string | null = 'agent-1'): PaneScope => ({
  kind: 'chat',
  name: 'Planning',
  targetId,
  agentPageId,
});

const terminal = (targetId: string | null): PaneScope => ({
  kind: 'terminal',
  name: 'shell-1',
  targetId,
  agentPageId: null,
});

describe('resolvePaneSurface', () => {
  it('given no scope, should show the picker', () => {
    expect(resolvePaneSurface(null)).toEqual({ surface: 'picker' });
  });

  it('given a bound chat pane, should render chat with its conversation and agent', () => {
    expect(resolvePaneSurface(chat('conv-1'))).toEqual({
      surface: 'chat',
      conversationId: 'conv-1',
      agentPageId: 'agent-1',
    });
  });

  it('given a global-assistant conversation, should carry a null agentPageId rather than refusing', () => {
    expect(resolvePaneSurface(chat('conv-2', null))).toEqual({
      surface: 'chat',
      conversationId: 'conv-2',
      agentPageId: null,
    });
  });

  it('given a bound terminal pane, should render terminal with its shellId', () => {
    expect(resolvePaneSurface(terminal('shell-9'))).toEqual({ surface: 'terminal', shellId: 'shell-9' });
  });

  it('given a chat pane whose row is not minted yet, should hold on loading', () => {
    expect(resolvePaneSurface(chat(null))).toEqual({ surface: 'loading' });
  });

  it('given a TERMINAL pane whose row is not minted yet, should hold rather than mount an Xterm', () => {
    // The rule the old name-lookup version existed to protect: mounting a
    // terminal opens a PTY stream and registers this pane as a viewer
    // server-side. Rendering one on an unresolved binding is not a harmless
    // flash — it is a connection that then has to be torn down.
    expect(resolvePaneSurface(terminal(null))).toEqual({ surface: 'loading' });
  });

  it('should never return terminal for a chat binding, whatever the ids look like', () => {
    // The inverse of the same hazard: a chat pane resolved to an Xterm was the
    // concrete bug the old escape hatch ("unresolvable, therefore a terminal")
    // caused the moment a layout carried a chat pane.
    const surfaces = [chat('conv-1'), chat(null), chat('conv-1', null)].map(resolvePaneSurface);
    expect(surfaces.some((s) => s.surface === 'terminal')).toBe(false);
  });
});
