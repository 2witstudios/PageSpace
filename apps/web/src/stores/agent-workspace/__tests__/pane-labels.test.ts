// @vitest-environment node
/**
 * The client half of the label-free broadcast (security review HIGH 1).
 *
 * `workspace:updated` carries structure only, so this module has to make a
 * nameless grid render like a named one without a round-trip in the common
 * case, and ask for exactly one authorized read when it cannot.
 */
import { describe, it, expect } from 'vitest';
import {
  carryPaneLabelsForward,
  hasUnknownBoundTarget,
  paneLabelIndex,
  paneLabelKey,
} from '../pane-labels';
import type { WorkspaceState } from '../pane-reducer';

const scope = (kind: 'chat' | 'terminal' | 'page', targetId: string | null, name = '', agentPageId: string | null = null) => ({
  kind,
  targetId,
  name,
  agentPageId,
});

const stateOf = (panes: Array<{ id: string; scope: ReturnType<typeof scope> | null }>): WorkspaceState =>
  ({
    id: 'ws-1',
    columns: [{ id: 'col-1', panes }],
    activePaneId: panes[0]?.id ?? null,
    pendingPickerPaneId: null,
  }) as unknown as WorkspaceState;

describe('paneLabelKey', () => {
  it('keys on kind + targetId, and refuses an unbound pane', () => {
    expect(paneLabelKey(scope('chat', 'c1'))).toBe('chat:c1');
    expect(paneLabelKey(scope('chat', null))).toBeNull();
    expect(paneLabelKey(null)).toBeNull();
  });
});

describe('carryPaneLabelsForward', () => {
  it('re-dresses a label-free broadcast from what the client already knows', () => {
    const known = paneLabelIndex(stateOf([{ id: 'p1', scope: scope('chat', 'c1', 'Design review', 'agent-1') }]));
    // The broadcast: same binding, moved, and carrying no name.
    const incoming = stateOf([{ id: 'p1', scope: scope('chat', 'c1') }]);

    const dressed = carryPaneLabelsForward(known, incoming);
    expect(dressed.columns[0].panes[0].scope).toMatchObject({
      name: 'Design review',
      agentPageId: 'agent-1',
    });
  });

  it('leaves a target it has never seen exactly as it arrived', () => {
    const known = paneLabelIndex(stateOf([{ id: 'p1', scope: scope('chat', 'c1', 'Known') }]));
    const incoming = stateOf([
      { id: 'p1', scope: scope('chat', 'c1') },
      { id: 'p2', scope: scope('page', 'page-new') },
    ]);

    const dressed = carryPaneLabelsForward(known, incoming);
    expect(dressed.columns[0].panes[1].scope?.name).toBe('');
  });

  it('returns the same object when nothing needed filling (no churn on geometry)', () => {
    const known = paneLabelIndex(stateOf([{ id: 'p1', scope: scope('chat', 'c1', 'Same') }]));
    const incoming = stateOf([{ id: 'p1', scope: scope('chat', 'c1', 'Same') }]);
    expect(carryPaneLabelsForward(known, incoming)).toBe(incoming);
  });

  it('leaves unbound picker panes alone', () => {
    const known = paneLabelIndex(stateOf([{ id: 'p1', scope: scope('chat', 'c1', 'Known') }]));
    const incoming = stateOf([{ id: 'p2', scope: null }]);
    expect(carryPaneLabelsForward(known, incoming).columns[0].panes[0].scope).toBeNull();
  });
});

describe('hasUnknownBoundTarget — when the client must go read', () => {
  it('is false for a pure geometry change over known bindings', () => {
    const known = paneLabelIndex(stateOf([{ id: 'p1', scope: scope('chat', 'c1', 'Known') }]));
    expect(hasUnknownBoundTarget(known, stateOf([{ id: 'p1', scope: scope('chat', 'c1') }]))).toBe(false);
  });

  it('is true when a broadcast introduces a target this client has never labelled', () => {
    const known = paneLabelIndex(stateOf([{ id: 'p1', scope: scope('chat', 'c1', 'Known') }]));
    expect(hasUnknownBoundTarget(known, stateOf([{ id: 'p2', scope: scope('chat', 'c2') }]))).toBe(true);
  });

  it('is FALSE for a target already known to be unlabellable — no refetch loop', () => {
    // The viewer may not read this target, so the authorized GET returns an
    // empty name too. Treating that as "unknown" would fetch on every single
    // broadcast, forever.
    const known = paneLabelIndex(stateOf([{ id: 'p1', scope: scope('page', 'secret', '') }]));
    expect(hasUnknownBoundTarget(known, stateOf([{ id: 'p1', scope: scope('page', 'secret') }]))).toBe(false);
  });

  it('ignores unbound panes', () => {
    const known = paneLabelIndex(null);
    expect(hasUnknownBoundTarget(known, stateOf([{ id: 'p1', scope: null }]))).toBe(false);
  });
});
