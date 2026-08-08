/**
 * THE PLACEMENT POLICY — the shared answer to "where does 'show me this' go?"
 *
 * The server's `open_conversation` and the browser store both used to carry
 * their own copy of these five rules. This suite is the table they now share,
 * so a change to any rule has one place to break and one place to be reviewed.
 *
 * The client's two EXTRA refusals — an unsaved-edits guard and the #2295
 * live-conversation guard — are not duplicated here; they arrive through the
 * injected `isReplaceable` and are exercised via the injection cases below.
 * That injection point is the whole design: shared structure, caller-specific
 * refusals, rather than a merged predicate neither caller can read.
 */
import { describe, it, expect } from 'vitest';
import { isReplaceable, resolveOpenPlacement, type PaneState, type WorkspaceState } from '../workspace-layout-verbs';
import type { PaneScope } from '../contract';

const chat = (targetId: string | null, name = 'Conversation'): PaneScope => ({
  kind: 'chat',
  name,
  targetId,
  agentPageId: null,
});

const terminal = (targetId: string): PaneScope => ({
  kind: 'terminal',
  name: 'Shell',
  targetId,
  agentPageId: null,
});

const page = (targetId: string): PaneScope => ({
  kind: 'page',
  name: 'Doc',
  targetId,
  agentPageId: null,
});

/** A single-column grid of the given panes, focused on `activePaneId`. */
const gridOf = (panes: PaneState[], activePaneId = panes[0]?.id ?? ''): WorkspaceState => ({
  id: 'ses-1',
  columns: [{ id: 'col-1', panes }],
  activePaneId,
  pendingPickerPaneId: null,
});

const pane = (id: string, scope: PaneScope | null): PaneState => ({ id, scope });

describe('resolveOpenPlacement', () => {
  it('creates when there is no grid at all', () => {
    expect(resolveOpenPlacement(null, 'conv-1')).toEqual({ kind: 'create' });
  });

  it('focuses the pane already showing the target', () => {
    const state = gridOf([pane('pane-1', chat('conv-1')), pane('pane-2', chat('conv-2'))], 'pane-1');
    expect(resolveOpenPlacement(state, 'conv-2')).toEqual({ kind: 'focus', paneId: 'pane-2' });
  });

  it('never claims a null target is already showing — an in-flight mint has no identity yet', () => {
    // Two panes whose mints are still in flight both carry `targetId: null`.
    // Treating them as "showing null" would focus an unrelated pane.
    const state = gridOf([pane('pane-1', chat(null)), pane('pane-2', chat(null))], 'pane-1');
    expect(resolveOpenPlacement(state, null).kind).not.toBe('focus');
  });

  it('fills an unbound picker pane', () => {
    const state = gridOf([pane('pane-1', null)], 'pane-1');
    expect(resolveOpenPlacement(state, 'conv-1')).toEqual({ kind: 'assign', paneId: 'pane-1' });
  });

  it('fills a bound, resolved, non-terminal pane', () => {
    const state = gridOf([pane('pane-1', chat('conv-old'))], 'pane-1');
    expect(resolveOpenPlacement(state, 'conv-1')).toEqual({ kind: 'assign', paneId: 'pane-1' });
  });

  it('prefers the ACTIVE pane over an earlier eligible one', () => {
    // "Show me this" means "here, where I am looking" — not "in the leftmost
    // slot that happens to fit".
    const state = gridOf(
      [pane('pane-1', chat('conv-a')), pane('pane-2', chat('conv-b'))],
      'pane-2',
    );
    expect(resolveOpenPlacement(state, 'conv-1')).toEqual({ kind: 'assign', paneId: 'pane-2' });
  });

  it('falls back to the first eligible pane when the active one is not', () => {
    const state = gridOf(
      [pane('pane-1', chat('conv-a')), pane('pane-2', terminal('shell-1'))],
      'pane-2',
    );
    expect(resolveOpenPlacement(state, 'conv-1')).toEqual({ kind: 'assign', paneId: 'pane-1' });
  });

  it('never evicts a terminal — a running PTY has no reattach UI', () => {
    const state = gridOf([pane('pane-1', terminal('shell-1'))], 'pane-1');
    expect(resolveOpenPlacement(state, 'conv-1')).toEqual({ kind: 'split', fromPaneId: 'pane-1' });
  });

  it('never evicts a pane whose own mint is still in flight', () => {
    // Landing a selection there means the mint's success callback later
    // overwrites it with the stale pick.
    const state = gridOf([pane('pane-1', chat(null))], 'pane-1');
    expect(resolveOpenPlacement(state, 'conv-1')).toEqual({ kind: 'split', fromPaneId: 'pane-1' });
  });

  it('under preferSplit, fills ONLY an unbound picker pane', () => {
    // An agent ADDS a surface; it never navigates the user's panes.
    const bound = gridOf([pane('pane-1', chat('conv-old'))], 'pane-1');
    expect(resolveOpenPlacement(bound, 'conv-1', { preferSplit: true })).toEqual({
      kind: 'split',
      fromPaneId: 'pane-1',
    });

    const unbound = gridOf([pane('pane-1', null)], 'pane-1');
    expect(resolveOpenPlacement(unbound, 'conv-1', { preferSplit: true })).toEqual({
      kind: 'assign',
      paneId: 'pane-1',
    });
  });

  it('never evicts the excluded target — a tool call must not eat its own invoker', () => {
    const state = gridOf([pane('pane-1', chat('conv-invoker'))], 'pane-1');
    expect(resolveOpenPlacement(state, 'conv-1', { excludeTargetId: 'conv-invoker' })).toEqual({
      kind: 'split',
      fromPaneId: 'pane-1',
    });
  });

  it('splits from the ACTIVE pane when nothing is replaceable', () => {
    const state = gridOf(
      [pane('pane-1', terminal('shell-1')), pane('pane-2', terminal('shell-2'))],
      'pane-2',
    );
    expect(resolveOpenPlacement(state, 'conv-1')).toEqual({ kind: 'split', fromPaneId: 'pane-2' });
  });

  describe('the injected refusal (what the client adds, and the server does not)', () => {
    it('is ANDed with the shared predicate, never replaces it', () => {
      // A terminal stays ineligible even when the injection would allow it.
      const state = gridOf([pane('pane-1', terminal('shell-1'))], 'pane-1');
      expect(resolveOpenPlacement(state, 'conv-1', { isReplaceable: () => true })).toEqual({
        kind: 'split',
        fromPaneId: 'pane-1',
      });
    });

    it('can veto a pane the shared predicate would have accepted', () => {
      // This is the shape of the dirty-page and #2295 page-pane guards.
      const state = gridOf([pane('pane-1', page('page-1')), pane('pane-2', chat('conv-b'))], 'pane-1');
      expect(
        resolveOpenPlacement(state, 'conv-1', {
          isReplaceable: (candidate) => candidate.scope?.kind !== 'page',
        }),
      ).toEqual({ kind: 'assign', paneId: 'pane-2' });
    });

    it('vetoing every pane produces the split fallback', () => {
      const state = gridOf([pane('pane-1', chat('conv-a'))], 'pane-1');
      expect(resolveOpenPlacement(state, 'conv-1', { isReplaceable: () => false })).toEqual({
        kind: 'split',
        fromPaneId: 'pane-1',
      });
    });

    it('is not consulted for a target that is already showing', () => {
      // Focus is not a replacement, so a refusal has nothing to say about it.
      const state = gridOf([pane('pane-1', chat('conv-1'))], 'pane-1');
      expect(resolveOpenPlacement(state, 'conv-1', { isReplaceable: () => false })).toEqual({
        kind: 'focus',
        paneId: 'pane-1',
      });
    });
  });
});

/**
 * WHY A SERVER-SIDE PLACEMENT MUST NOT RACE THE PANE PICKER (issue #2373,
 * review finding — codex P1).
 *
 * `AgentPanes.handlePickAgent` binds its pane to a LOADING scope
 * (`{ kind: 'chat', targetId: null }`), POSTs the creation, then binds that
 * same pane to the new conversation. If the creation ALSO placed server-side,
 * the placement would run against a grid whose only candidate pane is that
 * loading one — and a loading pane is deliberately not replaceable, so the
 * placement resolves to `split` and opens a SECOND pane. The client's own bind
 * then leaves one conversation displayed twice.
 *
 * The rule below is what makes that true, so it is pinned here: creation places
 * only for callers with no client pane in flight (`placeInGrid`, see
 * `agent-workspaces-runtime.ts`).
 */
describe('a loading pane is not replaceable — the picker flow depends on it', () => {
  it('does not treat a chat pane awaiting its conversation as fillable', () => {
    expect(isReplaceable({ id: 'pane-1', scope: { kind: 'chat', name: 'New conversation', targetId: null, agentPageId: null } } as never)).toBe(false);
  });

  it('does treat an empty pane and a bound chat pane as fillable', () => {
    expect(isReplaceable({ id: 'p', scope: null } as never)).toBe(true);
    expect(isReplaceable({ id: 'p', scope: { kind: 'chat', name: 'x', targetId: 'conv-1', agentPageId: null } } as never)).toBe(true);
  });

  it('never treats a terminal as fillable — a shell is not a surface to evict', () => {
    expect(isReplaceable({ id: 'p', scope: { kind: 'terminal', name: 'sh', targetId: 'sh-1' } } as never)).toBe(false);
  });
});
