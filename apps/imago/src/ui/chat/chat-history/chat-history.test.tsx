// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { click, mount, unmountAll } from '@/ui/test-support/dom';
import { fakeWeb } from '@/ui/test-support/fake-web';
import { createInitialState } from '@/ui/store/state';
import { getUiState, setUiState } from '@/ui/store/store';
import { useRetainedChatSelection } from '@/retained-adapters/session-selection';
import { pointers, conversationsPage, agentConversation } from '../chat-model/fixtures';
import { chatPaths } from '../chat-api/chat-api';
import { ChatHistory } from './chat-history';
beforeEach(() => { setUiState(createInitialState()); useRetainedChatSelection.getState().select(null); });
afterEach(unmountAll);
async function show() {
  const web = fakeWeb({
    [`GET ${chatPaths.builtinAgents}`]: () => Response.json(pointers()),
    [`GET ${chatPaths.conversations('p-imago', 0)}`]: () => Response.json(conversationsPage([agentConversation('c1'), agentConversation('c2')])),
  });
  const container = mount(<ImagoSWRProvider client={web.client}><ChatHistory /></ImagoSWRProvider>);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  return container;
}
it('shows the current agent’s real conversation summaries', async () => {
  const container = await show(); expect(container.textContent).toContain('Chat c1'); expect(container.textContent).toContain('Chat c2');
});
it('history selection clears a workspace binding and opens the selected plain conversation', async () => {
  const container = await show();
  useRetainedChatSelection.getState().select({ sessionId: 'w1', conversationId: 's1', agentId: 'a1', driveId: 'd1', isReadOnly: false });
  const button = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Chat c2'))!;
  click(button); expect(getUiState().resources.chatConversationId).toBe('c2'); expect(useRetainedChatSelection.getState().selection).toBeNull();
});
it('New chat keeps the shared unsent draft and clears a workspace selection', async () => {
  const container = await show();
  const button = container.querySelector<HTMLElement>('[aria-label="New chat"]')!;
  click(button); expect(getUiState().resources.chatNew).toBe(true); expect(getUiState().resources.chatConversationId).toBeNull();
});
