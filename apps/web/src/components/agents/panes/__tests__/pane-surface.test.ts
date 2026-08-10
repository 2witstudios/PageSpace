import { describe, it, expect } from 'vitest';
import type { PaneNode } from '@pagespace/lib/agent-workspaces/workspace-node';
import { resolvePaneSurface } from '../pane-surface';

function node(target: PaneNode['target']): PaneNode {
  return { nodeType: 'pane', id: 'n1', parentId: 'R', position: 0, target };
}

describe('resolvePaneSurface', () => {
  it('should show the picker for an unbound pane', () => {
    expect(resolvePaneSurface(node(null), false)).toEqual({ surface: 'picker' });
  });

  /**
   * The one rule that survived the model change intact, and the reason there is
   * still a `loading` case: opening a PTY stream registers this pane as a viewer
   * server-side, so guessing "terminal" for what turns out to be a chat is not a
   * harmless flash, it is a connection.
   */
  it('should hold on an unbound pane with a mint in flight, rather than guess', () => {
    expect(resolvePaneSurface(node(null), true)).toEqual({ surface: 'loading' });
  });

  it('should resolve each bound kind', () => {
    expect(resolvePaneSurface(node({ kind: 'chat', id: 'c1' }), false)).toEqual({
      surface: 'chat',
      conversationId: 'c1',
    });
    expect(resolvePaneSurface(node({ kind: 'terminal', id: 'shell-1' }), false)).toEqual({
      surface: 'terminal',
      shellId: 'shell-1',
    });
    expect(resolvePaneSurface(node({ kind: 'page', id: 'page-1' }), false)).toEqual({
      surface: 'page',
      pageId: 'page-1',
    });
  });

  it('should ignore a mint flag on a pane that is already bound', () => {
    // A bound pane keeps showing what it shows: the mint that is in flight is
    // for a REPLACEMENT, and blanking a working transcript for the length of a
    // round trip would be strictly worse than waiting.
    expect(resolvePaneSurface(node({ kind: 'chat', id: 'c1' }), true)).toEqual({
      surface: 'chat',
      conversationId: 'c1',
    });
  });

  it('should hold — never fall through to a terminal — for a kind it has never heard of', () => {
    const foreign = node({ kind: 'video' as never, id: 'x' });
    expect(resolvePaneSurface(foreign, false)).toEqual({ surface: 'loading' });
  });
});
