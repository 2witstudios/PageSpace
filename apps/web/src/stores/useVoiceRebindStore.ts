import { create } from 'zustand';
import { NO_REBIND_INTENT, type RebindIntent } from '@/lib/ai/realtime/voice-rebind';

/**
 * The user's decision to move a live call to a different agent, in transit.
 *
 * WHY A STORE AND NOT A PROP. The two ends are structurally separated and
 * cannot be joined by a prop: the agent switcher lives inside the chat surfaces
 * (`SidebarChatTab`, `GlobalAssistantView`), either of which can unmount — the
 * sidebar is unmounted outright when it is collapsed — while the thing that
 * ACTS on the decision has to outlive them, because resolving the new agent's
 * conversation is asynchronous and the user may collapse the panel in the
 * meantime. A callback owned by the surface would be a rebind that silently
 * fails to happen for anyone who closed the sidebar at the wrong moment.
 *
 * WHY IT HOLDS AN INTENT AND NOT A TARGET. At the instant of the click there is
 * no target: `selectAgent` clears the conversation id and re-resolves it. The
 * only thing known then is WHO the user chose, which is exactly what this
 * carries.
 *
 * Not persisted, and deliberately so: a call does not survive a reload, so an
 * intent restored from storage would be a rebind request for a session that no
 * longer exists.
 */
interface VoiceRebindState {
  intent: RebindIntent;
  /**
   * "This call should be talking to this agent." `null` means the global
   * assistant, which is a real destination and not the absence of one.
   */
  requestRebind: (agentPageId: string | null) => void;
  /** Acted on, or abandoned because nothing is live. */
  clearRebind: () => void;
}

export const useVoiceRebindStore = create<VoiceRebindState>()((set) => ({
  intent: NO_REBIND_INTENT,
  requestRebind: (agentPageId) => set({ intent: { kind: 'pending', agentPageId } }),
  clearRebind: () =>
    set((state) => (state.intent.kind === 'none' ? state : { intent: NO_REBIND_INTENT })),
}));
