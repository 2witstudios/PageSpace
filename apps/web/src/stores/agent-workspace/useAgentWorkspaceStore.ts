import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PaneScope } from '@pagespace/lib/agent-sessions/contract';
import {
  newWorkspace,
  assignPane as assignPaneIn,
  clearPanePrompt as clearPanePromptIn,
  dismissPicker as dismissPickerIn,
  splitRight as splitRightIn,
  splitDown as splitDownIn,
  closePane as closePaneIn,
  selectPane as selectPaneIn,
  type WorkspaceState,
} from './pane-reducer';

/**
 * Where each conversation's pane layout lives.
 *
 * Every transition delegates to the pure reducer — this store is the IO shell
 * (identity minting, persistence, subscription) and holds no layout logic of
 * its own, which is what keeps the reducer exhaustively testable without React.
 *
 * **Persisted, not synced.** The old machine grid pushed layouts to the server
 * (`useMachineWorkspaceSync`); that is deliberately not restored. A layout is a
 * local view preference, and syncing it made every split a write.
 *
 * Keyed by conversationId: the conversation IS the workspace unit, so opening a
 * conversation restores the grid you left it in, and the PTYs behind those panes
 * are still running server-side to reattach to.
 */

interface AgentWorkspaceState {
  /** conversationId → its grid. */
  workspaces: Record<string, WorkspaceState>;
  /** Give a conversation its opening grid, once. Idempotent. */
  ensureWorkspace(conversationId: string, scope: PaneScope): void;
  splitRight(conversationId: string, fromPaneId: string): void;
  splitDown(conversationId: string, fromPaneId: string): void;
  closePane(conversationId: string, paneId: string): void;
  selectPane(conversationId: string, paneId: string): void;
  assignPane(conversationId: string, paneId: string, scope: PaneScope): void;
  dismissPicker(conversationId: string, paneId: string): void;
  clearPanePrompt(conversationId: string, paneId: string): void;
  /** Drop a conversation's grid entirely (the conversation itself was deleted). */
  forgetWorkspace(conversationId: string): void;
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
 * Applies a reducer transition to one workspace. A conversation with no grid
 * yet is a no-op rather than an error: a transition can land after the grid was
 * forgotten (a close racing a conversation delete), and there is nothing
 * meaningful to create from a split of something absent.
 */
function updateWorkspace(
  state: AgentWorkspaceState,
  conversationId: string,
  transition: (workspace: WorkspaceState) => WorkspaceState,
): Partial<AgentWorkspaceState> | null {
  const current = state.workspaces[conversationId];
  if (!current) return null;
  const next = transition(current);
  if (next === current) return null;
  return { workspaces: { ...state.workspaces, [conversationId]: next } };
}

export const useAgentWorkspaceStore = create<AgentWorkspaceState>()(
  persist(
    (set) => ({
      workspaces: {},

      ensureWorkspace: (conversationId, scope) =>
        set((state) => {
          if (state.workspaces[conversationId]) return {};
          return {
            workspaces: {
              ...state.workspaces,
              [conversationId]: newWorkspace({
                conversationId,
                paneId: mintId('pane'),
                columnId: mintId('col'),
                scope,
              }),
            },
          };
        }),

      splitRight: (conversationId, fromPaneId) =>
        set(
          (state) =>
            updateWorkspace(state, conversationId, (workspace) =>
              splitRightIn(workspace, fromPaneId, mintId('col'), mintId('pane')),
            ) ?? {},
        ),

      splitDown: (conversationId, fromPaneId) =>
        set(
          (state) =>
            updateWorkspace(state, conversationId, (workspace) =>
              splitDownIn(workspace, fromPaneId, mintId('pane')),
            ) ?? {},
        ),

      closePane: (conversationId, paneId) =>
        set((state) => updateWorkspace(state, conversationId, (w) => closePaneIn(w, paneId)) ?? {}),

      selectPane: (conversationId, paneId) =>
        set((state) => updateWorkspace(state, conversationId, (w) => selectPaneIn(w, paneId)) ?? {}),

      assignPane: (conversationId, paneId, scope) =>
        set((state) => updateWorkspace(state, conversationId, (w) => assignPaneIn(w, paneId, scope)) ?? {}),

      dismissPicker: (conversationId, paneId) =>
        set((state) => updateWorkspace(state, conversationId, (w) => dismissPickerIn(w, paneId)) ?? {}),

      clearPanePrompt: (conversationId, paneId) =>
        set((state) => updateWorkspace(state, conversationId, (w) => clearPanePromptIn(w, paneId)) ?? {}),

      forgetWorkspace: (conversationId) =>
        set((state) => {
          if (!state.workspaces[conversationId]) return {};
          const { [conversationId]: _dropped, ...rest } = state.workspaces;
          return { workspaces: rest };
        }),
    }),
    { name: 'agent-workspace-storage' },
  ),
);
