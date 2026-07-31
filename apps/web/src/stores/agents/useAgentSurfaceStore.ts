import { create } from 'zustand';

import { buildAgentSelectionUrl, parseAgentSelection } from '@/lib/agents/agent-selection';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useTabsStore } from '@/stores/useTabsStore';

/**
 * What is selected on the Agents surface — and nothing else.
 *
 * Deliberately NOT an extension of `usePageAgentDashboardStore`. That store owns
 * the right-sidebar assistant's conversation IDENTITY state machine (resolving /
 * ready / failed, message-cache seeding, most-recent-conversation resolution);
 * this one owns three ids and a URL. Folding them together would give the surface
 * a state machine it doesn't need and give the assistant a drive scope it
 * doesn't have. One grammar, one module (`lib/agents/agent-selection.ts`).
 *
 * ## Selection is not navigation
 *
 * Every transition mirrors to the URL with `history.pushState` and NOTHING else.
 * No `router.push`, no route change, therefore no remount — which is why this
 * surface needs no successor to `MachineKeepAliveHost`. The old Development
 * surface put the selection in the PATH, so every click was a navigation, so
 * every click tore down the xterm buffers and sockets the surface existed to
 * keep alive, so it grew a host component whose entire job was to render
 * machines OUTSIDE the route tree. Moving the selection into the query string
 * deletes that whole category of problem: a live PTY or a streaming chat cannot
 * be unmounted by a click that doesn't unmount anything.
 *
 * ## The URL is the state
 *
 * There is no in-memory selection the URL cannot reconstruct. A deep link, a
 * refresh, and the Back button all reach identical state through the same
 * `hydrateFromSearch` — Back works because the pushed entries are real history
 * entries, and `popstate` needs no special handling beyond re-reading the URL
 * the browser has already restored.
 */

/**
 * The viewport below which the left sidebar is a sheet rather than furniture.
 * Hoisted so the store's imperative check and the sidebar's `useBreakpoint`
 * subscription can never disagree about where that line is.
 */
export const SHEET_BREAKPOINT_QUERY = '(max-width: 1023px)';

interface HydrateInput {
  /** Defaults to the live `window.location.search` — what a `popstate` handler wants. */
  search?: string;
  /** The drive segment this surface is mounted under; absent/undefined = global mode. */
  driveId?: string | null;
}

interface AgentSurfaceState {
  /** Which surface we're on, so transitions stay inside it. Null = `/dashboard/agents`. */
  driveId: string | null;
  /** The selected SESSION (workspace) — what the centre view's pane grid renders. */
  selectedSessionId: string | null;
  /** The conversation inside that session the grid opened on. */
  selectedConversationId: string | null;
  /** The selected conversation's agent page — the pane grid's seed. */
  selectedAgentId: string | null;

  /**
   * Select a session (or `null` to clear). Switching to a DIFFERENT session
   * clears the conversation — it belonged to the old workspace — while
   * re-selecting the session already open keeps it, so clicking the row you're
   * on is a no-op rather than a way to lose your place.
   */
  selectSession: (sessionId: string | null) => void;

  /**
   * Select a conversation inside a session, naming the session and the
   * conversation's agent so a click lands as ONE transition (one history
   * entry) with all params agreeing. `conversationId: null` clears just the
   * conversation (e.g. its listing closed with no live chat pane to fall
   * back to) while keeping the session selected.
   */
  selectConversation: (input: {
    sessionId: string;
    conversationId: string | null;
    agentId: string | null;
  }) => void;

  /** Read the URL into state. Reading, not selecting: writes no history entry. */
  hydrateFromSearch: (input?: HydrateInput) => void;
}

/** The current address as `buildAgentSelectionUrl` would spell it, for comparison. */
function currentUrl(): string | null {
  if (typeof window === 'undefined') return null;
  return `${window.location.pathname}${window.location.search}`;
}

/**
 * Selection used to navigate, and navigating closed the sheet for free. Now
 * nothing closes it unless this does — leaving a mobile user staring at the
 * sidebar they just picked from, with their choice hidden behind it.
 *
 * Only on an actual selection, and only under the breakpoint: on desktop the
 * sidebar is permanent furniture, and closing it would hide the tree the user is
 * still browsing.
 */
function closeSheetIfMobile(): void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  if (!window.matchMedia(SHEET_BREAKPOINT_QUERY).matches) return;
  useLayoutStore.getState().setLeftSheetOpen(false);
}

export const useAgentSurfaceStore = create<AgentSurfaceState>()((set, get) => {
  /**
   * The one write path. Sets state and mirrors it to the URL — skipping the
   * `pushState` when the URL would be byte-identical to the one already there,
   * so re-selecting what's already open doesn't stack duplicate Back entries a
   * user would have to press through to get anywhere.
   */
  const commit = (next: { sessionId: string | null; conversationId: string | null; agentId: string | null }) => {
    set({
      selectedSessionId: next.sessionId,
      selectedConversationId: next.conversationId,
      selectedAgentId: next.agentId,
    });

    if (typeof window === 'undefined') return;
    const url = buildAgentSelectionUrl({
      driveId: get().driveId,
      sessionId: next.sessionId,
      conversationId: next.conversationId,
      agentId: next.agentId,
    });
    if (url === currentUrl()) return;
    window.history.pushState({}, '', url);
    // Next's own `pushState` patch does eventually fold this into its router
    // state too (it copies its internal history markers onto any external
    // push and dispatches a restore, which is what makes `useSearchParams()`
    // in `AgentsSurface`/`useTabSync` react to this at all) — but that path is
    // async (wrapped in a `startTransition`). Set it directly here as well so
    // the tab bar's record of this tab's address is correct the instant this
    // selection commits, not just eventually.
    useTabsStore.getState().updateActiveTabSearch(url.split('?')[1] ?? '');
  };

  return {
    driveId: null,
    selectedSessionId: null,
    selectedConversationId: null,
    selectedAgentId: null,

    selectSession: (sessionId) => {
      const { selectedSessionId, selectedConversationId, selectedAgentId } = get();
      const isSameSession = sessionId === selectedSessionId;
      commit({
        sessionId,
        conversationId: isSameSession ? selectedConversationId : null,
        agentId: isSameSession ? selectedAgentId : null,
      });
      closeSheetIfMobile();
    },

    selectConversation: ({ sessionId, conversationId, agentId }) => {
      commit({ sessionId, conversationId, agentId });
      closeSheetIfMobile();
    },

    hydrateFromSearch: (input) => {
      const search = input?.search ?? (typeof window === 'undefined' ? '' : window.location.search);
      const selection = parseAgentSelection(search);
      set({
        // Only when the caller actually said — a hydrate that omits the key
        // (e.g. a bare popstate re-read) must not silently drop the drive scope.
        ...(input && 'driveId' in input ? { driveId: input.driveId ?? null } : {}),
        selectedSessionId: selection.sessionId,
        selectedConversationId: selection.conversationId,
        selectedAgentId: selection.agentId,
      });
    },
  };
});
