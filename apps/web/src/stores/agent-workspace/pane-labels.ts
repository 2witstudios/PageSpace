/**
 * Client-side pane LABELS, now that the room broadcast carries none
 * (security review HIGH 1).
 *
 * `workspace:updated` fans out to `session:<id>` — one payload, every member
 * of a shared workspace. There is no viewer to redact for on that wire, so
 * the server ships the STRUCTURAL grid (pane ids, kinds, targetIds, size
 * shares, rev) and no names at all. Names come from each client's own
 * authorized reads instead: the access-checked `GET /workspace`, whose
 * labels are resolved for exactly that viewer.
 *
 * That leaves this module with one job: make a label-free broadcast render
 * like a labelled one, without a network round-trip for the common case.
 *
 *   - A pane the client ALREADY knows keeps its name (`carryPaneLabelsForward`)
 *     — which covers every geometry verb (move, resize, reorder, close), i.e.
 *     the overwhelming majority of broadcasts. Those apply live, exactly as
 *     before.
 *   - A broadcast that introduces a target this client has never labelled
 *     (`hasUnknownBoundTarget`) is the only case that needs a read, and the
 *     store answers it with `refreshWorkspaceSnapshot`.
 *
 * The "already knows" index deliberately records EMPTY names too: a pane
 * whose target the viewer genuinely may not read resolves no label on the GET
 * either, and treating that as unknown would make every subsequent broadcast
 * fire a fetch that can never fill it in.
 *
 * Everything here is pure.
 */

import type { WorkspaceState } from '@pagespace/lib/agent-workspaces/workspace-layout-verbs';

/** A pane's label facts, keyed by what the pane is bound to. */
export interface PaneLabelIndex {
  get(key: string): { name: string; agentPageId: string | null } | undefined;
  has(key: string): boolean;
}

/** The index key for a binding. `null` for an unbound (picker) pane. */
export function paneLabelKey(scope: { kind: string; targetId: string | null } | null): string | null {
  if (!scope || scope.targetId === null) return null;
  return `${scope.kind}:${scope.targetId}`;
}

/** Every label this client currently knows, empty names included. */
export function paneLabelIndex(state: WorkspaceState | null): PaneLabelIndex {
  const index = new Map<string, { name: string; agentPageId: string | null }>();
  if (!state) return index;
  for (const column of state.columns) {
    for (const pane of column.panes) {
      const key = paneLabelKey(pane.scope);
      if (key === null || !pane.scope) continue;
      index.set(key, { name: pane.scope.name, agentPageId: pane.scope.agentPageId });
    }
  }
  return index;
}

/**
 * Fill each bound pane's label from `index`, leaving a pane the index does
 * not know exactly as it arrived (an empty name the caller will go resolve).
 * Returns `next` UNCHANGED by identity when nothing needed filling, so a
 * broadcast that changed only geometry does not churn referential equality.
 */
export function carryPaneLabelsForward(index: PaneLabelIndex, next: WorkspaceState): WorkspaceState {
  let changed = false;
  const columns = next.columns.map((column) => ({
    ...column,
    panes: column.panes.map((pane) => {
      const key = paneLabelKey(pane.scope);
      if (key === null || !pane.scope) return pane;
      const known = index.get(key);
      if (!known) return pane;
      if (pane.scope.name === known.name && pane.scope.agentPageId === known.agentPageId) return pane;
      changed = true;
      return { ...pane, scope: { ...pane.scope, name: known.name, agentPageId: known.agentPageId } };
    }),
  }));
  return changed ? { ...next, columns } : next;
}

/**
 * Does `next` bind a target this client has never had a label for? That — and
 * only that — is worth an authorized read; a pane whose label is known to be
 * empty is already as resolved as it will ever get for this viewer.
 */
export function hasUnknownBoundTarget(index: PaneLabelIndex, next: WorkspaceState): boolean {
  for (const column of next.columns) {
    for (const pane of column.panes) {
      const key = paneLabelKey(pane.scope);
      if (key !== null && !index.has(key)) return true;
    }
  }
  return false;
}
