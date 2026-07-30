import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PaneScope } from '@pagespace/lib/agent-sessions/contract';
import {
  newWorkspace,
  paneShowing,
  panesOf,
  assignPane as assignPaneIn,
  dismissPicker as dismissPickerIn,
  splitRight as splitRightIn,
  splitDown as splitDownIn,
  closePane as closePaneIn,
  selectPane as selectPaneIn,
  type WorkspaceState,
} from './pane-reducer';

/**
 * Where each session's pane layout lives.
 *
 * Every transition delegates to the pure reducer — this store is the IO shell
 * (identity minting, persistence, subscription) and holds no layout logic of
 * its own, which is what keeps the reducer exhaustively testable without React.
 *
 * **Persisted, not synced.** The old machine grid pushed layouts to the server
 * (`useMachineWorkspaceSync`); that is deliberately not restored. A layout is a
 * local view preference, and syncing it made every split a write.
 *
 * Keyed by SESSION id: the session is the workspace unit (it owns the sandbox
 * every pane shares), so opening a session restores the grid you left it in,
 * and the PTYs behind those panes are still running server-side to reattach to.
 *
 * **A session is never empty, in both directions.** It is born with its first
 * conversation in its first pane, and closing the LAST pane is intercepted
 * HERE — the store forgets the grid and reports it, so the caller can end the
 * session (tear down its sandbox) as the same act. The pure reducer's
 * `closePane` deliberately no-ops on the last pane because a `WorkspaceState`
 * transition cannot delete its own container; this interception is the
 * container level the old `closePaneIn` owned.
 */

interface AgentWorkspaceState {
  /** sessionId → its grid. */
  workspaces: Record<string, WorkspaceState>;
  /** Give a session its opening grid, once. Idempotent. */
  ensureWorkspace(sessionId: string, scope: PaneScope): void;
  /**
   * Make a conversation VISIBLE in the session's grid — what a sidebar or
   * history selection means (review M1: `ensureWorkspace` alone no-ops on a
   * persisted grid, so clicking a conversation the layout didn't already show
   * changed the URL and nothing else). Focus the pane already showing it;
   * otherwise open it in the active pane when that pane is a chat/picker, or
   * in the first chat pane — never over a TERMINAL (a running PTY loses its
   * only surface; there is no reattach UI). With every pane a terminal, split
   * the active pane right.
   */
  openConversation(sessionId: string, scope: PaneScope): void;
  splitRight(sessionId: string, fromPaneId: string): void;
  splitDown(sessionId: string, fromPaneId: string): void;
  /**
   * Close a pane. Closing the LAST pane removes the whole grid and returns
   * `'session-ended'` — the caller owns the IO that ends the session; the
   * store owns only the layout fact.
   */
  closePane(sessionId: string, paneId: string): 'closed' | 'session-ended' | 'noop';
  selectPane(sessionId: string, paneId: string): void;
  assignPane(sessionId: string, paneId: string, scope: PaneScope): void;
  dismissPicker(sessionId: string, paneId: string): void;
  /** Drop a session's grid entirely (the session was ended elsewhere). */
  forgetWorkspace(sessionId: string): void;
}

/**
 * `crypto.randomUUID` where available, with a counter fallback so a
 * non-secure-context browser (or a test environment without it) still mints
 * distinct pane ids rather than colliding on one.
 */
let paneCounter = 0;
function mintId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  paneCounter += 1;
  return `${prefix}-${paneCounter}`;
}

/**
 * Applies a reducer transition to one workspace. A SESSION with no grid yet
 * is a no-op rather than an error: a transition can land after the grid was
 * forgotten (a close racing a session end), and there is nothing meaningful
 * to create from a split of something absent.
 */
function updateWorkspace(
  state: AgentWorkspaceState,
  sessionId: string,
  transition: (workspace: WorkspaceState) => WorkspaceState,
): Partial<AgentWorkspaceState> | null {
  const current = state.workspaces[sessionId];
  if (!current) return null;
  const next = transition(current);
  if (next === current) return null;
  return { workspaces: { ...state.workspaces, [sessionId]: next } };
}

export const useAgentWorkspaceStore = create<AgentWorkspaceState>()(
  persist(
    (set) => ({
      workspaces: {},

      ensureWorkspace: (sessionId, scope) =>
        set((state) => {
          if (state.workspaces[sessionId]) return {};
          return {
            workspaces: {
              ...state.workspaces,
              [sessionId]: newWorkspace({
                sessionId,
                paneId: mintId('pane'),
                columnId: mintId('col'),
                scope,
              }),
            },
          };
        }),

      openConversation: (sessionId, scope) => {
        const state = useAgentWorkspaceStore.getState();
        const workspace = state.workspaces[sessionId];
        if (!workspace) {
          state.ensureWorkspace(sessionId, scope);
          return;
        }
        if (scope.targetId !== null) {
          const showing = paneShowing(workspace, scope.targetId);
          if (showing) {
            state.selectPane(sessionId, showing.id);
            return;
          }
        }
        const panes = panesOf(workspace);
        const active = panes.find((pane) => pane.id === workspace.activePaneId);
        const replaceable =
          active && active.scope?.kind !== 'terminal'
            ? active
            : panes.find((pane) => pane.scope?.kind !== 'terminal');
        if (replaceable) {
          state.assignPane(sessionId, replaceable.id, scope);
          return;
        }
        // Every pane is a running terminal — open beside them.
        set(
          (current) =>
            updateWorkspace(current, sessionId, (w) => {
              const split = splitRightIn(w, w.activePaneId, mintId('col'), mintId('pane'));
              return assignPaneIn(split, split.activePaneId, scope);
            }) ?? {},
        );
      },

      splitRight: (sessionId, fromPaneId) =>
        set(
          (state) =>
            updateWorkspace(state, sessionId, (workspace) =>
              splitRightIn(workspace, fromPaneId, mintId('col'), mintId('pane')),
            ) ?? {},
        ),

      splitDown: (sessionId, fromPaneId) =>
        set(
          (state) =>
            updateWorkspace(state, sessionId, (workspace) =>
              splitDownIn(workspace, fromPaneId, mintId('pane')),
            ) ?? {},
        ),

      closePane: (sessionId, paneId) => {
        const current = useAgentWorkspaceStore.getState().workspaces[sessionId];
        if (!current) return 'noop';
        const paneExists = panesOf(current).some((pane) => pane.id === paneId);
        if (!paneExists) return 'noop';
        if (panesOf(current).length <= 1) {
          // The LAST pane: emptying a session ends it. The reducer no-ops on
          // this by design (it cannot delete its own container); the store is
          // the container, so the interception lives here — the old
          // `closePaneIn`'s job, restored at the level that owns the grid map.
          set((state) => {
            const { [sessionId]: _dropped, ...rest } = state.workspaces;
            return { workspaces: rest };
          });
          return 'session-ended';
        }
        set((state) => updateWorkspace(state, sessionId, (w) => closePaneIn(w, paneId)) ?? {});
        return 'closed';
      },

      selectPane: (sessionId, paneId) =>
        set((state) => updateWorkspace(state, sessionId, (w) => selectPaneIn(w, paneId)) ?? {}),

      assignPane: (sessionId, paneId, scope) =>
        set((state) => updateWorkspace(state, sessionId, (w) => assignPaneIn(w, paneId, scope)) ?? {}),

      dismissPicker: (sessionId, paneId) =>
        set((state) => updateWorkspace(state, sessionId, (w) => dismissPickerIn(w, paneId)) ?? {}),

      forgetWorkspace: (sessionId) =>
        set((state) => {
          if (!state.workspaces[sessionId]) return {};
          const { [sessionId]: _dropped, ...rest } = state.workspaces;
          return { workspaces: rest };
        }),
    }),
    { name: 'agent-workspace-storage' },
  ),
);
