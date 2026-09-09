/**
 * The pane grid's layout, its two viewport rules, and the recursion.
 *
 * The mobile assertions are the ones worth having hardest: both encode bugs that
 * are invisible in a screenshot and expensive in production (a reaped PTY, a
 * permanently blank terminal). The recursion assertions are new, and they exist
 * because the two-level version could not express a third level at all — so
 * "renders a nested split" was previously not a case that could fail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PaneNode, WorkspaceNode } from '@pagespace/lib/agent-workspaces/workspace-node';

const mobileState = vi.hoisted(() => ({ current: false }));
vi.mock('@/hooks/useMobile', () => ({ useMobile: () => mobileState.current }));

import SessionPanes from '../SessionPanes';

const WS = 'ws-1';
const root: WorkspaceNode = { nodeType: 'root', id: WS, parentId: null, position: 0, axis: 'row' };

function pane(id: string, parentId: string, position: number, fraction?: number): WorkspaceNode {
  return { nodeType: 'pane', id, parentId, position, target: null, ...(fraction === undefined ? {} : { fraction }) };
}
function split(id: string, parentId: string, position: number, axis: 'row' | 'column'): WorkspaceNode {
  return { nodeType: 'split', id, parentId, position, axis };
}

/** One pane under the root — the simplest legal grid. */
const single: WorkspaceNode[] = [root, pane('p1', WS, 0)];
/** Two panes side by side. */
const pair: WorkspaceNode[] = [root, pane('p1', WS, 0), pane('p2', WS, 1)];

function renderGrid(nodes: WorkspaceNode[], activeNodeId: string | null, onSelectPane = vi.fn()) {
  const seen: Array<{ id: string; isActive: boolean; canSplit: boolean }> = [];
  const { container } = render(
    <SessionPanes
      nodes={nodes}
      activeNodeId={activeNodeId}
      onSelectPane={onSelectPane}
      renderPane={({ node, isActive, canSplit }) => {
        seen.push({ id: node.id, isActive, canSplit });
        return <div data-testid={`pane-body-${node.id}`}>{node.id}</div>;
      }}
      paneLabel={(node: PaneNode) => `label-${node.id}`}
    />,
  );
  return { seen, onSelectPane, container };
}

/**
 * The panes in DOM order — which is the property that matters and is NOT what
 * the `renderPane` capture order reports. React renders a nested container as a
 * child ELEMENT, so its panes are invoked in a later pass than a sibling pane of
 * the container itself; the capture order is React's, the DOM order is the
 * reader's.
 */
const domOrder = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[data-testid^="pane-body-"]')].map(
    (element) => element.getAttribute('data-testid')?.replace('pane-body-', '') ?? '',
  );

beforeEach(() => {
  mobileState.current = false;
});

describe('SessionPanes — desktop grid', () => {
  it('should render every pane in the grid', () => {
    const { seen } = renderGrid(pair, 'p1');
    expect(seen.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('should mark exactly the active pane active', () => {
    const { seen } = renderGrid(pair, 'p2');
    expect(seen.filter((p) => p.isActive).map((p) => p.id)).toEqual(['p2']);
  });

  it('should allow splitting on a wide viewport', () => {
    const { seen } = renderGrid(single, 'p1');
    expect(seen.every((p) => p.canSplit)).toBe(true);
  });

  it('should fall back to the first pane when the active id names nothing', () => {
    const { seen } = renderGrid(pair, 'gone');
    expect(seen.filter((p) => p.isActive).map((p) => p.id)).toEqual(['p1']);
  });

  /**
   * THE RECURSION. A container renders its children the same way at every depth,
   * so a split inside a split inside a split is one loop rather than a level the
   * two-level model had no spelling for.
   */
  it('should render a THREE-deep nesting, which the two-level grid could not express', () => {
    const deep: WorkspaceNode[] = [
      root,
      split('s1', WS, 0, 'column'),
      pane('p1', 's1', 0),
      split('s2', 's1', 1, 'row'),
      pane('p2', 's2', 0),
      split('s3', 's2', 1, 'column'),
      pane('p3', 's3', 0),
      pane('p4', 's3', 1),
    ];
    const { seen, container } = renderGrid(deep, 'p1');
    expect(seen.map((p) => p.id).sort()).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(domOrder(container)).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('should render children in depth-first order — the order a reader\'s eye takes', () => {
    const nested: WorkspaceNode[] = [
      root,
      split('s1', WS, 0, 'column'),
      pane('a', 's1', 0),
      pane('b', 's1', 1),
      pane('c', WS, 1),
    ];
    const { seen, container } = renderGrid(nested, 'a');
    expect(seen.map((p) => p.id).sort()).toEqual(['a', 'b', 'c']);
    expect(domOrder(container)).toEqual(['a', 'b', 'c']);
  });

  /**
   * Every pane the workspace holds IS a rectangle now. This used to assert the
   * opposite for a parked node — a member that was deliberately not drawn — and
   * what remains worth pinning is that the walk reaches every one of them.
   */
  it('should render every pane the tree holds, at every depth', () => {
    const nested: WorkspaceNode[] = [
      root,
      pane('p1', WS, 0),
      split('s1', WS, 1, 'column'),
      pane('deep', 's1', 0),
      pane('beside', 's1', 1),
    ];
    const { seen } = renderGrid(nested, 'p1');
    expect(seen.map((p) => p.id).sort()).toEqual(['beside', 'deep', 'p1']);
  });

  it('should ignore a split holding nothing rather than render an empty frame for it', () => {
    const degenerate: WorkspaceNode[] = [root, pane('p1', WS, 0), split('empty', WS, 1, 'row')];
    const { seen } = renderGrid(degenerate, 'p1');
    expect(seen.map((p) => p.id)).toEqual(['p1']);
  });
});

/**
 * THE EMPTY GRID — a resting state, not a failure. Closing the last pane
 * destroys it and leaves the SESSION alive with a root holding nothing, which
 * the two-level model could not represent at all (so the reducer no-oped on the
 * last close and browser code ended the session instead).
 */
describe('SessionPanes — nothing on the grid', () => {
  it('should render the empty frame for a root holding nothing', () => {
    renderGrid([root], null);
    expect(screen.getByTestId('empty-grid')).toBeDefined();
    expect(screen.queryByTestId('session-panes')).toBeNull();
  });

  it('should render the empty frame for a workspace with no root at all', () => {
    renderGrid([], null);
    expect(screen.getByTestId('empty-grid')).toBeDefined();
  });

  it('should render the empty frame for a root whose only child is an empty split', () => {
    renderGrid([root, split('empty', WS, 0, 'row')], null);
    expect(screen.getByTestId('empty-grid')).toBeDefined();
  });

  it('should point at the sidebar, where the workspace\'s members still are', () => {
    renderGrid([root], null);
    expect(screen.getByText(/sidebar/i)).toBeDefined();
  });
});

describe('SessionPanes — narrow viewport', () => {
  beforeEach(() => {
    mobileState.current = true;
  });

  it('should render a single pane full-bleed with no switcher', () => {
    renderGrid(single, 'p1');
    expect(screen.queryByTestId('pane-strip')).toBeNull();
    expect(screen.getByTestId('pane-body-p1')).toBeDefined();
  });

  it('should offer a switcher once a split layout exists', async () => {
    const { onSelectPane } = renderGrid(pair, 'p1');
    const strip = screen.getByTestId('pane-strip');
    await userEvent.click(within(strip).getByText('label-p2'));
    expect(onSelectPane).toHaveBeenCalledWith('p2');
  });

  /**
   * HIDDEN, NOT UNMOUNTED. Unmounting a terminal emits a disconnect, removing
   * this pane's viewer entry and — when it was the last — arming the idle reap:
   * an agent that finished off-screen would lose its final output, and returning
   * would cold-start a fresh PTY.
   */
  it('should keep the inactive panes mounted', () => {
    const { seen } = renderGrid(pair, 'p1');
    expect(seen.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(screen.getByTestId('pane-body-p2')).toBeDefined();
  });

  /**
   * `invisible` (visibility:hidden), NOT `hidden` (display:none). xterm measures
   * its character cell from the DOM at `open()`, and in a display:none box that
   * measurement is 0 — the fit addon then proposes no dimensions, so even the
   * refit on re-show is a no-op and the pane stays blank for good.
   */
  it('should hide the inactive pane with visibility, not display', () => {
    renderGrid(pair, 'p1');
    const hidden = screen.getAllByTestId('mobile-pane').filter((el) => el.dataset.hidden === 'true');
    expect(hidden).toHaveLength(1);
    expect(hidden[0].className).toContain('invisible');
    expect(hidden[0].className).not.toContain('hidden');
  });

  it('should hide the split controls, since a split grid is unusable at this width', () => {
    const { seen } = renderGrid(pair, 'p1');
    expect(seen.every((p) => p.canSplit)).toBe(false);
  });

  it('should render the empty frame rather than a switcher with nothing in it', () => {
    renderGrid([root], null);
    expect(screen.getByTestId('empty-grid')).toBeDefined();
  });
});
