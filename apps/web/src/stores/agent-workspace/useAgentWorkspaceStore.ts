import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PaneScope } from '@pagespace/lib/agent-sessions/contract';
import { useEditingStore } from '@/stores/useEditingStore';
import {
  newWorkspace,
  paneShowing,
  panesOf,
  assignPane as assignPaneIn,
  assignPaneShowing as assignPaneShowingIn,
  dismissPicker as dismissPickerIn,
  splitRight as splitRightIn,
  splitDown as splitDownIn,
  closePane as closePaneIn,
  isLastPane,
  resetPane as resetPaneIn,
  selectPane as selectPaneIn,
  type PaneState,
  type WorkspaceState,
} from './pane-reducer';
import { validatePersistedWorkspaces } from './persisted-workspace';

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
   *
   * `options.liveConversationIds`, when supplied, additionally protects a
   * chat pane whose target is NOT in that set — e.g. a conversation the user
   * closed out of this session (`closedInSessionAt`) — AND any page pane (a
   * deliberate, persisted artifact; a reload's seed effect used to silently
   * evict agent-opened pages this way) from an unrelated later selection
   * (issue #2295); both fall through to the split fallback instead, exactly
   * like a terminal/dirty pane does. Omitted (any caller that hasn't
   * learned the live set yet), behavior is unchanged — this guard is
   * strictly additive.
   */
  openConversation(
    sessionId: string,
    scope: PaneScope,
    options?: { liveConversationIds?: ReadonlySet<string> },
  ): void;
  /**
   * Make a PAGE visible in the session's grid — the page-pane sibling of
   * `openConversation`, sharing its focus-or-replace-or-split policy (with
   * two extra guards `openConversation` doesn't need, since a page pane can
   * hold unsaved edits and can itself BE the conversation that asked to open
   * it): a pane is never replaceable while its page has an active dirty
   * `useEditingStore` session, and `excludeTargetId` (the invoking
   * conversation's own id, for the agent-driven `open_page_pane` path) is
   * never replaced either — both fall through to a split instead. Used by
   * the picker's "Pages" section and by `useOpenPagePane`'s resolution.
   *
   * `options.preferSplit` (the agent-driven path): an agent opening a page
   * is ADDING a surface beside what the user is doing, not navigating —
   * with it set, no bound pane is ever evicted; only an unbound picker pane
   * may be filled, and otherwise the grid splits. Without it (a user pick),
   * the replace policy is unchanged: the user asked to see the page HERE.
   */
  openPage(
    sessionId: string,
    scope: PaneScope,
    options?: { excludeTargetId?: string; preferSplit?: boolean },
  ): void;
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
  /** Unbind a pane back to the picker — a failed mint, first-class rather than a sentinel scope. */
  resetPane(sessionId: string, paneId: string): void;
  dismissPicker(sessionId: string, paneId: string): void;
  /**
   * Point whichever pane is showing `oldConversationId` at its replacement.
   * Used when the current conversation is deleted and re-minted into the
   * SAME session (`AgentPageView`'s delete flow) — a no-op if the deleted
   * conversation was not showing in any pane.
   */
  replaceConversation(sessionId: string, oldConversationId: string, newScope: PaneScope): void;
  /** Drop a session's grid entirely (the session was ended elsewhere). */
  forgetWorkspace(sessionId: string): void;
  /**
   * Seed a session's grid from a server-saved layout — `useWorkspaceServerSync`'s
   * hydration path. Unconditional and server-wins (unlike `ensureWorkspace`,
   * which no-ops on an existing grid): whatever the mount-time seeding effect
   * already did to this session's grid is overwritten, by design. Ignored if
   * `workspace.id` doesn't match `sessionId` — a mismatch means the wrong
   * session's grid was fetched and must not be seated here. `activePaneId`
   * is normalized to the first pane if the saved value doesn't name a real
   * one in `columns` — the persisted schema doesn't cross-validate that
   * reference.
   */
  hydrateWorkspace(sessionId: string, workspace: WorkspaceState): void;
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

/**
 * Is `pane` a PAGE pane whose target currently has unsaved edits? Checked
 * against `useEditingStore` by pageId (not by the pane's own id — the
 * editing-store componentId carries a per-mount `useId()` suffix the pane
 * model knows nothing about), so a dirty document/canvas/sheet page is never
 * silently overwritten by `focusOrAssignScope`'s replace path (only 'document'
 * and 'form' session types count as dirty for this purpose — see
 * `useEditingStore.isAnyEditing`'s identical set).
 */
function isPaneDirty(pane: PaneState): boolean {
  if (pane.scope?.kind !== 'page' || pane.scope.targetId === null) return false;
  const targetPageId = pane.scope.targetId;
  return useEditingStore
    .getState()
    .getActiveSessions()
    .some((session) => (session.type === 'document' || session.type === 'form') && session.metadata?.pageId === targetPageId);
}

/**
 * Shared by `openConversation` and `openPage`: make `scope`'s target VISIBLE
 * in the session's grid. Focus the pane already showing it; otherwise replace
 * a replaceable pane (unbound, or bound to a resolved non-terminal row —
 * never a running terminal, which has no reattach UI; never one with unsaved
 * edits; never `options.excludeTargetId`, when given); otherwise split the
 * active pane right. Scope-kind-agnostic: a chat scope and a page scope
 * follow the identical policy, which is why one function serves both.
 */
function focusOrAssignScope(
  set: (fn: (state: AgentWorkspaceState) => Partial<AgentWorkspaceState>) => void,
  sessionId: string,
  scope: PaneScope,
  options?: {
    excludeTargetId?: string;
    liveConversationIds?: ReadonlySet<string>;
    preferSplit?: boolean;
  },
) {
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
  // Replaceable = unbound (picker), or bound to a resolved, non-terminal
  // row. A pane whose mint is still in flight (`targetId === null`) is
  // EXCLUDED even though its kind isn't terminal: landing a different
  // selection there now means the mint's own success callback later
  // overwrites it with the stale pick (review low-batch #1). Also excluded:
  // a pane with unsaved edits (`isPaneDirty`), and — when the caller passed
  // `excludeTargetId` — the pane already showing THAT target (the
  // `open_page_pane` tool's own invoking conversation must never be evicted
  // by its own tool call; it should get a split beside it instead). Also
  // excluded when the caller passed `liveConversationIds` (only
  // `openConversation` ever does, from the selection/mount-seed paths): a
  // BOUND pane whose scope is not a live chat — a conversation closed out
  // of this session (issue #2295), or a PAGE pane, a deliberate persisted
  // artifact a conversation selection has no business evicting (a reload's
  // seed effect used to eat agent-opened page panes this way) — must never
  // be silently overwritten by an unrelated later selection; both fall
  // through to the split fallback instead, exactly like a terminal. And
  // excluded wholesale under `preferSplit` (the agent-driven `openPage`
  // path): an agent adds a surface, it never navigates the user's panes,
  // so only an unbound picker pane may be filled.
  const isReplaceable = (pane: PaneState) =>
    (pane.scope === null || (pane.scope.kind !== 'terminal' && pane.scope.targetId !== null)) &&
    !isPaneDirty(pane) &&
    (options?.excludeTargetId === undefined || pane.scope?.targetId !== options.excludeTargetId) &&
    (options?.preferSplit !== true || pane.scope === null) &&
    (options?.liveConversationIds === undefined ||
      pane.scope === null ||
      (pane.scope.kind === 'chat' &&
        (pane.scope.targetId === null || options.liveConversationIds.has(pane.scope.targetId))));
  const replaceable = active && isReplaceable(active) ? active : panes.find(isReplaceable);
  if (replaceable) {
    state.assignPane(sessionId, replaceable.id, scope);
    return;
  }
  // Nothing replaceable (every pane is a running terminal, dirty, or the
  // excluded invoker) — open beside them instead of losing anything.
  set(
    (current) =>
      updateWorkspace(current, sessionId, (w) => {
        const split = splitRightIn(w, w.activePaneId, mintId('col'), mintId('pane'));
        return assignPaneIn(split, split.activePaneId, scope);
      }) ?? {},
  );
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

      openConversation: (sessionId, scope, options) => focusOrAssignScope(set, sessionId, scope, options),

      openPage: (sessionId, scope, options) => focusOrAssignScope(set, sessionId, scope, options),

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
        if (!panesOf(current).some((pane) => pane.id === paneId)) return 'noop';
        if (isLastPane(current, paneId)) {
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

      resetPane: (sessionId, paneId) =>
        set((state) => updateWorkspace(state, sessionId, (w) => resetPaneIn(w, paneId)) ?? {}),

      dismissPicker: (sessionId, paneId) =>
        set((state) => updateWorkspace(state, sessionId, (w) => dismissPickerIn(w, paneId)) ?? {}),

      replaceConversation: (sessionId, oldConversationId, newScope) =>
        set(
          (state) =>
            updateWorkspace(state, sessionId, (w) => assignPaneShowingIn(w, oldConversationId, newScope)) ?? {},
        ),

      forgetWorkspace: (sessionId) =>
        set((state) => {
          if (!state.workspaces[sessionId]) return {};
          const { [sessionId]: _dropped, ...rest } = state.workspaces;
          return { workspaces: rest };
        }),

      hydrateWorkspace: (sessionId, workspace) =>
        set((state) => {
          // `workspace.id` is documented as "the SESSION id whose grid this
          // is" — a mismatch means the caller fetched the wrong session's
          // saved grid (or the server payload was tampered with); seating it
          // under a DIFFERENT session's key would poison every consumer that
          // trusts `workspace.id` (review finding).
          if (workspace.id !== sessionId) return {};
          // The persisted schema doesn't cross-validate that `activePaneId`
          // names a real pane in `columns` — normalize it here, at the one
          // place a saved grid enters the store, rather than leaving every
          // consumer (`SessionPanes.tsx`'s render, future callers) to each
          // grow their own fallback (review finding).
          const panes = panesOf(workspace);
          const normalized = panes.some((pane) => pane.id === workspace.activePaneId)
            ? workspace
            : { ...workspace, activePaneId: panes[0].id };
          return { workspaces: { ...state.workspaces, [sessionId]: normalized } };
        }),
    }),
    {
      name: 'agent-workspace-storage',
      // Bumped when the persisted grid shape changes; paired with `merge`
      // below so a stale or corrupted grid is dropped on rehydrate rather
      // than trusted — see `validatePersistedWorkspaces`.
      version: 1,
      partialize: (state) => ({ workspaces: state.workspaces }),
      merge: (persisted, current) => ({
        ...current,
        workspaces: validatePersistedWorkspaces(persisted),
      }),
    },
  ),
);
