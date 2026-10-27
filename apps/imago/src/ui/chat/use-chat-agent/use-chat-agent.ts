'use client';

// The agent the chat talks to, read the same way by every chat surface (the
// pane and its history), so both always show the same agent's conversations:
// the one chosen in the chat header, else Imago.

import { useUiState } from '@/ui/store/store';
import type { UiState } from '@/ui/store/state';
import { useImagoAgents } from '../use-chat-data/use-chat-data';

const selectAgent = (state: UiState) => state.resources.chatAgent;

/** The viewer's Imago agents, the chosen agent (null: Imago) and the page id the chat talks to (null until known). */
export const useChatAgent = () => {
  const { agents, error } = useImagoAgents();
  const chosenAgent = useUiState(selectAgent);
  const imago = agents?.find((entry) => entry.key === 'imago');
  return {
    agents,
    imago,
    chosenAgent,
    agentId: chosenAgent?.id ?? imago?.pageId ?? null,
    agentName: chosenAgent?.title ?? imago?.title ?? 'Imago',
    error,
  };
};
