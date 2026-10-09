// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { UIMessage } from 'ai';
import { useOpenPagePane } from '@/retained/lib/ai/shared/hooks/useOpenPagePane';
const navigateToPage = vi.hoisted(() => vi.fn());
vi.mock('@/retained/hooks/usePageNavigation', () => ({ usePageNavigation: () => ({ navigateToPage }) }));
const assistant = (state: string, call = 'call1'): UIMessage => ({
  id: 'm1', role: 'assistant', parts: [{ type: 'tool-open_page_pane', toolCallId: call, state,
    ...(state === 'output-available' ? { input: { pageId: 'other-drive-page' }, output: { opened: true, pageId: 'other-drive-page' } } : { input: { pageId: 'other-drive-page' } }) }] as UIMessage['parts'],
});
it('opens a newly completed page tool without requiring a workspace session, once per call', () => {
  navigateToPage.mockClear();
  const { rerender, unmount } = renderHook(({ messages }) => useOpenPagePane({ sessionId: null, conversationId: 'c1', messages }), { initialProps: { messages: [assistant('input-available')] } });
  rerender({ messages: [assistant('output-available')] });
  expect(navigateToPage).toHaveBeenCalledExactlyOnceWith('other-drive-page');
  rerender({ messages: [assistant('output-available')] });
  expect(navigateToPage).toHaveBeenCalledTimes(1);
  unmount();
});
it('does not replay completed history after mount or conversation selection', () => {
  navigateToPage.mockClear();
  const { rerender, unmount } = renderHook(({ conversationId }) => useOpenPagePane({ sessionId: null, conversationId, messages: [assistant('output-available')] }), { initialProps: { conversationId: 'c1' } });
  rerender({ conversationId: 'c2' });
  expect(navigateToPage).not.toHaveBeenCalled();
  unmount();
});
