import { create } from 'zustand';

import { buildAgentSelectionUrl, parseAgentSelection } from '@/lib/agents/agent-selection';
import { useLayoutStore } from '@/stores/useLayoutStore';

/**
 * What is selected on the Agents surface — and nothing else.
 *
 * Deliberately NOT an extension of `usePageAgentDashboardStore`. That store owns
 * the right-sidebar assistant's conversation IDENTITY state machine (resolving /
 * ready / failed, message-cache seeding, most-recent-conversation resolution);
 * this one owns two ids and a URL. Folding them together would give the surface
 * a state machine it doesn't need and give the assistant a drive scope it
 * doesn't have. They do share the `?agent=`/`?c=` grammar — one grammar, one
 * module (`lib/agents/agent-selection.ts`), two readers.
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
  selectedAgentId: string | null;
  /** ≡ the sessionId of whatever the user has open (see the agent-sessions contract). */
  selectedConversationId: string | null;

  /**
   * Select an agent (or `null` to clear). Switching to a DIFFERENT agent clears
   * the conversation — it belonged to the old agent — while re-selecting the
   * agent already open keeps it, so clicking the row you're on is a no-op rather
   * than a way to lose your place.
   */
  selectAgent: (agentId: string | null) => void;

  /**
   * Select a conversation, optionally naming the agent it belongs to. Passing
   * the owning agent is how a click on a conversation nested under a different
   * agent lands as ONE transition (and one history entry) with both params
   * agreeing, instead of two writes with a moment of disagreement between them.
   */
  selectConversation: (conversationId: string | null, agentId?: string | null) => void;

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
  const commit = (next: { agentId: string | null; conversationId: string | null }) => {
    set({ selectedAgentId: next.agentId, selectedConversationId: next.conversationId });

    if (typeof window === 'undefined') return;
    const url = buildAgentSelectionUrl({
      driveId: get().driveId,
      agentId: next.agentId,
      conversationId: next.conversationId,
    });
    if (url === currentUrl()) return;
    window.history.pushState({}, '', url);
  };

  return {
    driveId: null,
    selectedAgentId: null,
    selectedConversationId: null,

    selectAgent: (agentId) => {
      const { selectedAgentId, selectedConversationId } = get();
      const isSameAgent = agentId === selectedAgentId;
      commit({ agentId, conversationId: isSameAgent ? selectedConversationId : null });
      closeSheetIfMobile();
    },

    selectConversation: (conversationId, agentId) => {
      const nextAgentId = agentId === undefined ? get().selectedAgentId : agentId;
      commit({ agentId: nextAgentId, conversationId });
      closeSheetIfMobile();
    },

    hydrateFromSearch: (input) => {
      const search = input?.search ?? (typeof window === 'undefined' ? '' : window.location.search);
      const selection = parseAgentSelection(search);
      set({
        // Only when the caller actually said — a hydrate that omits the key
        // (e.g. a bare popstate re-read) must not silently drop the drive scope.
        ...(input && 'driveId' in input ? { driveId: input.driveId ?? null } : {}),
        selectedAgentId: selection.agentId,
        selectedConversationId: selection.conversationId,
      });
    },
  };
});
