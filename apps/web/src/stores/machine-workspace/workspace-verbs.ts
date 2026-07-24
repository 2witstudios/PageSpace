/**
 * Machine Workspace — verb algebra (#2202: entity promotion).
 *
 * The successor to full-blob PUT/PATCH: a workspace/pane mutation is one of a
 * small, closed set of VERBS, each an ordered, idempotent transition over
 * {@link MachineWorkspacesState}. `applyVerbLocal` is THE single definition of
 * "what a verb does" — imported by both the browser's optimistic local apply
 * (`useMachineWorkspaceStore.ts`) and the server's verb engine
 * (`apps/web/src/lib/machines/workspace-verbs-runtime.ts`, still inside this
 * same Next.js app, so no cross-package boundary or duplicated copy is
 * needed — unlike the blob era's `session-layout.ts`, which had to re-run a
 * COPY of this reducer server-side to stay "byte-identical").
 *
 * Every verb case follows the reducer's existing no-op convention: a target
 * that doesn't resolve (unknown workspace/pane id) returns the state
 * unchanged, surfaced here as `applied: false`. This is a STRUCTURAL check
 * (did the transition run at all), not a deep content diff — a retried
 * `bind-pane` to the SAME session, for instance, structurally "applies" again
 * (new object references throughout) even though nothing observable changed.
 * The final authority on whether bytes actually changed is the persistence
 * layer's own content diff (`machine-panes-store.ts`'s `replaceWorkspaceGrid`,
 * which compares grids by value) — that is what decides whether a verb's
 * effect is broadcast. `applied` here only tells a caller whether the target
 * existed, e.g. to skip a network push for a `create-workspace` retry.
 */

import {
  addWorkspace,
  assignPane,
  closePaneIn,
  machineNodeScope,
  newWorkspace,
  paneTerminalScope,
  removeWorkspace,
  removedWorkspaceBy,
  renameWorkspace,
  showSessionIn,
  splitDown,
  splitRight,
  updateWorkspace,
  type MachineWorkspacesState,
  type PaneSessionScope,
} from './workspace-reducer';

/** What a pane binds to — identical shape to {@link PaneSessionScope}, named
 * for the verb envelope (this is what crosses the wire in a verb body). */
export type SessionRef = PaneSessionScope;

export type WorkspaceVerb =
  | {
      type: 'create-workspace';
      workspaceId: string;
      name: string;
      scope: { projectName?: string; branchName?: string };
      firstPaneId: string;
      /** `null` = born empty, showing the picker; set = born-bound. */
      session: SessionRef | null;
    }
  | { type: 'rename-workspace'; workspaceId: string; name: string }
  | { type: 'remove-workspace'; workspaceId: string }
  | {
      type: 'split-pane';
      workspaceId: string;
      fromPaneId: string;
      direction: 'right' | 'down';
      /** Only meaningful for `direction: 'right'` — the reducer mints one
       * column per rightward split regardless, so an omitted id just means
       * "use the new pane's id for the new column's id too" (today's client
       * convention). */
      newColumnId?: string;
      newPaneId: string;
      /** Optional bind-in-the-same-verb — used by the AI planner's
       * `split-into` placement so a split pane is never briefly unbound on
       * the wire; the UI's manual split (picker-driven) omits it. */
      session?: SessionRef;
    }
  | { type: 'bind-pane'; workspaceId: string; paneId: string; session: SessionRef }
  | { type: 'close-pane'; workspaceId: string; paneId: string }
  /** Server-side equivalent of the client's `showSessionIn`: focus the pane
   * already showing this session, fill an empty pane with it, or split a new
   * one — whichever applies. Used when a session already has a home
   * somewhere in the workspace and the caller doesn't know (or care) which
   * pane that is. */
  | { type: 'add-pane'; workspaceId: string; newPaneId: string; session: SessionRef };

export interface WorkspaceVerbOutcome {
  state: MachineWorkspacesState;
  /** See the module doc — a structural "did the target resolve" flag, not a
   * content diff. */
  applied: boolean;
  /** Set only when this verb removed a workspace (`remove-workspace`, or
   * `close-pane` on a workspace's last pane) — lets a caller broadcast
   * `workspace: null` for exactly that id. */
  removedWorkspaceId?: string;
}

const NOT_APPLIED = (state: MachineWorkspacesState): WorkspaceVerbOutcome => ({ state, applied: false });

export function applyVerbLocal(state: MachineWorkspacesState, verb: WorkspaceVerb): WorkspaceVerbOutcome {
  switch (verb.type) {
    case 'create-workspace': {
      if (state.workspaces[verb.workspaceId]) return NOT_APPLIED(state);
      const workspace = newWorkspace({
        id: verb.workspaceId,
        name: verb.name,
        scope: machineNodeScope(verb.scope),
        firstPaneId: verb.firstPaneId,
        firstPaneScope: verb.session,
      });
      return { state: addWorkspace(state, workspace), applied: true };
    }

    case 'rename-workspace': {
      if (!state.workspaces[verb.workspaceId]) return NOT_APPLIED(state);
      const next = renameWorkspace(state, verb.workspaceId, verb.name);
      return { state: next, applied: next !== state };
    }

    case 'remove-workspace': {
      if (!state.workspaces[verb.workspaceId]) return NOT_APPLIED(state);
      const next = removeWorkspace(state, verb.workspaceId);
      return { state: next, applied: true, removedWorkspaceId: verb.workspaceId };
    }

    case 'split-pane': {
      if (!state.workspaces[verb.workspaceId]) return NOT_APPLIED(state);
      let applied = false;
      const next = updateWorkspace(state, verb.workspaceId, (ws) => {
        const columnId = verb.newColumnId ?? verb.newPaneId;
        const split = verb.direction === 'right' ? splitRight(ws, verb.fromPaneId, columnId, verb.newPaneId) : splitDown(ws, verb.fromPaneId, verb.newPaneId);
        if (split === ws) return ws;
        applied = true;
        return verb.session ? assignPane(split, verb.newPaneId, paneTerminalScope(ws.scope, verb.session)) : split;
      });
      return { state: next, applied };
    }

    case 'bind-pane': {
      if (!state.workspaces[verb.workspaceId]) return NOT_APPLIED(state);
      let applied = false;
      const next = updateWorkspace(state, verb.workspaceId, (ws) => {
        const bound = assignPane(ws, verb.paneId, paneTerminalScope(ws.scope, verb.session));
        if (bound === ws) return ws;
        applied = true;
        return bound;
      });
      return { state: next, applied };
    }

    case 'close-pane': {
      if (!state.workspaces[verb.workspaceId]) return NOT_APPLIED(state);
      const next = closePaneIn(state, verb.workspaceId, verb.paneId);
      if (next === state) return NOT_APPLIED(state);
      const removedWorkspaceId = removedWorkspaceBy(state, next, verb.workspaceId) ? verb.workspaceId : undefined;
      return { state: next, applied: true, removedWorkspaceId };
    }

    case 'add-pane': {
      if (!state.workspaces[verb.workspaceId]) return NOT_APPLIED(state);
      let applied = false;
      const next = updateWorkspace(state, verb.workspaceId, (ws) => {
        const shown = showSessionIn(ws, paneTerminalScope(ws.scope, verb.session), verb.newPaneId);
        applied = true;
        return shown;
      });
      return { state: next, applied };
    }
  }
}

/** The workspace every verb addresses — used by callers (route dispatch, the
 * verb engine) that need to load/lock one workspace's state without a switch
 * over every verb shape themselves. */
export function workspaceIdOf(verb: WorkspaceVerb): string {
  return verb.workspaceId;
}
