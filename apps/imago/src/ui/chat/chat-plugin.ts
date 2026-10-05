import type { UiState } from '../store/state';
import type { UiPlugin } from '../store/transactions';

/** The conversation an agent turn is streaming into. */
export type StreamingTurn = { readonly conversationId: string };

const withStreaming = (state: UiState, streaming: StreamingTurn | null): UiState => ({
  ...state,
  resources: { ...state.resources, streaming },
});

/** Whether a turn is streaming into this conversation: its messages must not be revalidated meanwhile. */
export const isStreaming = (state: UiState, conversationId: string | null): boolean =>
  conversationId !== null && state.resources.streaming?.conversationId === conversationId;

/**
 * The Chat section's shell state: which conversation a turn is streaming
 * into. The messages themselves live in SWR and the turn hook, not here.
 */
export const chatPlugin = {
  transactions: {
    startStreaming: (state: UiState, conversationId: string): UiState =>
      isStreaming(state, conversationId) ? state : withStreaming(state, { conversationId }),
    endStreaming: (state: UiState, conversationId: string): UiState =>
      isStreaming(state, conversationId) ? withStreaming(state, null) : state,
  },
} satisfies UiPlugin;
