/**
 * The pane grid's layout and its two viewport rules. The mobile assertions are
 * the ones worth having: both encode bugs that are invisible in a screenshot
 * and expensive in production (a reaped PTY, a permanently blank terminal).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PaneScope } from '@pagespace/lib/agent-sessions/contract';
import { newWorkspace, splitRight, splitDown, type WorkspaceState } from '@/stores/agent-workspace/pane-reducer';

const mobileState = vi.hoisted(() => ({ current: false }));
vi.mock('@/hooks/useMobile', () => ({ useMobile: () => mobileState.current }));

import SessionPanes from '../SessionPanes';

const scope = (name: string): PaneScope => ({ kind: 'chat', name, targetId: 'conv-1', agentPageId: 'agent-1' });

function base(): WorkspaceState {
  return newWorkspace({ sessionId: 'ses-1', paneId: 'pane-1', columnId: 'col-1', scope: scope('Planning') });
}

function renderGrid(workspace: WorkspaceState, onSelectPane = vi.fn()) {
  const seen: Array<{ id: string; isActive: boolean; canSplit: boolean }> = [];
  render(
    <SessionPanes
      workspace={workspace}
      onSelectPane={onSelectPane}
      renderPane={({ pane, isActive, canSplit }) => {
        seen.push({ id: pane.id, isActive, canSplit });
        return <div data-testid={`pane-body-${pane.id}`}>{pane.id}</div>;
      }}
    />,
  );
  return { seen, onSelectPane };
}

beforeEach(() => {
  mobileState.current = false;
});

describe('SessionPanes — desktop grid', () => {
  it('should render every pane of every column', () => {
    let state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    state = splitDown(state, 'pane-1', 'pane-3');
    const { seen } = renderGrid(state);
    expect(seen.map((p) => p.id).sort()).toEqual(['pane-1', 'pane-2', 'pane-3']);
  });

  it('should mark exactly the active pane active', () => {
    const state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    const { seen } = renderGrid(state);
    expect(seen.filter((p) => p.isActive).map((p) => p.id)).toEqual(['pane-2']);
  });

  it('should allow splitting on a wide viewport', () => {
    const { seen } = renderGrid(base());
    expect(seen.every((p) => p.canSplit)).toBe(true);
  });

  it('should not render the narrow-viewport strip', () => {
    const state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    renderGrid(state);
    expect(screen.queryByTestId('pane-strip')).not.toBeInTheDocument();
  });

  it('given an activePaneId that no longer resolves, should fall back to the first pane rather than mark NONE active', () => {
    // The store always points activePaneId at a live pane, but a grid
    // restored from the server isn't schema-guaranteed to (no
    // cross-reference check on the persisted shape) — same fallback the
    // mobile branch already has, applied here too.
    let state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    state = { ...state, activePaneId: 'ghost' };
    const { seen } = renderGrid(state);
    expect(seen.filter((p) => p.isActive).map((p) => p.id)).toEqual(['pane-1']);
  });
});

describe('SessionPanes — narrow viewport', () => {
  beforeEach(() => {
    mobileState.current = true;
  });

  it('should still MOUNT every pane — unmounting one reaps its PTY', () => {
    // Unmounting a terminal emits a disconnect, removes this pane's viewer and,
    // when it was the last, arms the idle reap. An agent that finished while its
    // pane was off-screen would lose its final output and exit code, and coming
    // back would cold-start a fresh PTY instead of showing the completed run.
    const state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    const { seen } = renderGrid(state);
    expect(seen.map((p) => p.id).sort()).toEqual(['pane-1', 'pane-2']);
    expect(screen.getByTestId('pane-body-pane-1')).toBeInTheDocument();
    expect(screen.getByTestId('pane-body-pane-2')).toBeInTheDocument();
  });

  it('should hide inactive panes with visibility, NOT display', () => {
    // `invisible` (visibility:hidden), never `hidden` (display:none). xterm
    // measures its character cell from the DOM at open(), and in a display:none
    // box that measurement is 0 — the fit addon then proposes no dimensions, so
    // even the refit on re-show is a no-op and the pane stays blank for good.
    const state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    renderGrid(state);
    const hidden = screen.getAllByTestId('mobile-pane').filter((el) => el.dataset.hidden === 'true');
    expect(hidden).toHaveLength(1);
    expect(hidden[0].className).toContain('invisible');
    expect(hidden[0].className).not.toContain('hidden');
  });

  it('should hide exactly the non-active panes', () => {
    const state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    renderGrid(state);
    const visible = screen.getAllByTestId('mobile-pane').filter((el) => el.dataset.hidden === undefined);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toHaveTextContent('pane-2');
  });

  it('should forbid splitting — two columns at phone width are unusable slivers', () => {
    const { seen } = renderGrid(base());
    expect(seen.every((p) => p.canSplit)).toBe(false);
  });

  it('should show the pane strip only once a split layout exists', () => {
    renderGrid(base());
    expect(screen.queryByTestId('pane-strip')).not.toBeInTheDocument();
  });

  it('should offer the strip as the only route back to collapsed panes', () => {
    // Without it those panes are silently unreachable — the failure mode the
    // whole narrow-viewport branch exists to avoid.
    const state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    renderGrid(state);
    expect(screen.getByTestId('pane-strip')).toBeInTheDocument();
  });

  it('should select a pane from the strip', async () => {
    const state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    const onSelectPane = vi.fn();
    renderGrid(state, onSelectPane);
    await userEvent.click(screen.getAllByRole('button')[0]);
    expect(onSelectPane).toHaveBeenCalledWith('pane-1');
  });

  it('given an activePaneId that no longer resolves, should still show something', () => {
    const state: WorkspaceState = { ...base(), activePaneId: 'ghost' };
    renderGrid(state);
    const visible = screen.getAllByTestId('mobile-pane').filter((el) => el.dataset.hidden === undefined);
    expect(visible).toHaveLength(1);
  });
});
