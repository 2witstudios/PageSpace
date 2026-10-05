import type { UiSlice, UiState } from '../store/state';

/** The conversation an agent turn is streaming into. */
export type StreamingTurn = { readonly conversationId: string };

const withStreaming = (state: UiState, streaming: StreamingTurn | null): UiState => ({
  ...state,
  resources: { ...state.resources, streaming },
});

/** Whether a turn is streaming into this conversation: its messages must not be revalidated meanwhile. */
export const isStreaming = (state: UiState, conversationId: string | null): boolean =>
  conversationId !== null && state.resources.streaming?.conversationId === conversationId;

const withResources = (state: UiState, resources: Partial<UiState['resources']>): UiState => ({
  ...state,
  resources: { ...state.resources, ...resources },
});

/**
 * The Chat section's shell state: which conversation a turn is streaming
 * into, the composer's draft and the conversation the pane shows. The
 * messages themselves live in SWR and the turn hook, not here. Each
 * transaction returns the same snapshot when nothing changes.
 */
export const chatPlugin = {
  resources: (): {
    /** The conversation an agent turn is streaming into; SWR leaves it alone meanwhile. */
    readonly streaming: StreamingTurn | null;
    /** What the viewer has typed in the chat composer; kept across navigation. */
    readonly chatDraft: string;
    /** The conversation the chat pane shows; null until one is chosen (the agent's latest). */
    readonly chatConversationId: string | null;
  } => ({ streaming: null, chatDraft: '', chatConversationId: null }),
  transactions: {
    startStreaming: (state: UiState, conversationId: string): UiState =>
      isStreaming(state, conversationId) ? state : withStreaming(state, { conversationId }),
    endStreaming: (state: UiState, conversationId: string): UiState =>
      isStreaming(state, conversationId) ? withStreaming(state, null) : state,
    setChatDraft: (state: UiState, chatDraft: string): UiState =>
      state.resources.chatDraft === chatDraft ? state : withResources(state, { chatDraft }),
    openConversation: (state: UiState, chatConversationId: string): UiState =>
      state.resources.chatConversationId === chatConversationId ? state : withResources(state, { chatConversationId }),
  },
} satisfies UiSlice;
