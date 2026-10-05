import type { UiSlice, UiState } from '../store/state';
import type { ChatAgent } from './chat-model/chat';

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

const sameAgent = (a: ChatAgent | null, b: ChatAgent | null): boolean => a?.id === b?.id;

/**
 * The Chat section's shell state: which conversation a turn is streaming
 * into, the composer's draft, the agent the pane talks to and the
 * conversation it shows. The
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
    /** The agent chosen in the chat header; null is Imago, the default. */
    readonly chatAgent: ChatAgent | null;
    /** The name of the agent the viewer lost access to, for the notice; null when none was. */
    readonly chatAgentLost: string | null;
  } => ({ streaming: null, chatDraft: '', chatConversationId: null, chatAgent: null, chatAgentLost: null }),
  transactions: {
    startStreaming: (state: UiState, conversationId: string): UiState =>
      isStreaming(state, conversationId) ? state : withStreaming(state, { conversationId }),
    endStreaming: (state: UiState, conversationId: string): UiState =>
      isStreaming(state, conversationId) ? withStreaming(state, null) : state,
    setChatDraft: (state: UiState, chatDraft: string): UiState =>
      state.resources.chatDraft === chatDraft ? state : withResources(state, { chatDraft }),
    openConversation: (state: UiState, chatConversationId: string): UiState =>
      state.resources.chatConversationId === chatConversationId ? state : withResources(state, { chatConversationId }),
    /** Talks to another agent (null: Imago) in its latest conversation; the draft stays. */
    selectAgent: (state: UiState, chatAgent: ChatAgent | null): UiState =>
      sameAgent(state.resources.chatAgent, chatAgent) && state.resources.chatAgentLost === null
        ? state
        : withResources(state, { chatAgent, chatConversationId: null, chatAgentLost: null }),
    /** The server refused the chosen agent: Imago answers instead, and the pane says why. */
    loseAgent: (state: UiState, agentId: string): UiState => {
      const lost = state.resources.chatAgent;
      return lost?.id !== agentId
        ? state
        : withResources(state, { chatAgent: null, chatConversationId: null, chatAgentLost: lost.title });
    },
  },
} satisfies UiSlice;
