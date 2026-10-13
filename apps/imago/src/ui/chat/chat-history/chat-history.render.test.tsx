import { renderToString } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { agentConversation } from '../chat-model/fixtures';
import { chatHistoryRowClass } from './chat-history-class';
import { renderChatHistory, type ChatHistoryRenderProps } from './chat-history.render';

const noop = () => {};

const ready: ChatHistoryRenderProps['list'] = {
  status: 'ready',
  days: [
    { label: 'Today', conversations: [agentConversation('c3', { title: 'Q3 launch' }), agentConversation('c2')] },
    { label: 'Yesterday', conversations: [agentConversation('c1', { title: 'Roadmap review' })] },
    { label: 'Sep 18', conversations: [agentConversation('c0')] },
  ],
  hasMore: false,
  loadingMore: false,
};

const markup = (props: Partial<ChatHistoryRenderProps> = {}): string =>
  renderToString(
    renderChatHistory({
      list: ready,
      activeId: 'c3',
      selectConversation: noop,
      startNewChat: noop,
      hide: noop,
      loadMore: noop,
      retry: noop,
      ...props,
    }),
  );

describe('renderChatHistory', () => {
  test('a named pane of past chats', () => {
    const html = markup();
    assert({
      given: 'the chat history',
      should: 'name the region and list every past chat by its title',
      actual: [html.includes('aria-label="Chat history"'), ['Q3 launch', 'Chat c2', 'Roadmap review', 'Chat c0'].every((title) => html.includes(title))],
      expected: [true, true],
    });
  });

  test('day groups in order, in sentence case', () => {
    const html = markup();
    const at = (label: string): number => html.indexOf(`>${label}</h2>`);
    assert({
      given: 'chats from today, yesterday and an earlier date',
      should: 'head each group with its label, newest first, never shouting',
      actual: [at('Today') > 0, at('Today') < at('Yesterday'), at('Yesterday') < at('Sep 18'), html.includes('uppercase')],
      expected: [true, true, true, false],
    });
  });

  test('a row is a button with its title alone', () => {
    const html = markup();
    const rows = html.slice(html.indexOf('>Today</h2>'));
    assert({
      given: 'the rows under the group headings',
      should: 'switch the chat in place (a button, not a link) and draw no icon, since every row would carry the same one',
      actual: [rows.includes('<a '), rows.includes('<svg'), rows.includes(`<button type="button" class="${chatHistoryRowClass(true)}" aria-current="true">`)],
      expected: [false, false, true],
    });
  });

  test('marks the open chat, and none for a new one', () => {
    assert({
      given: 'an open past chat, then a new chat',
      should: 'mark exactly one row current, then none',
      actual: [(markup().match(/aria-current="true"/g) ?? []).length, (markup({ activeId: null }).match(/aria-current="true"/g) ?? []).length],
      expected: [1, 0],
    });
  });

  test('header controls', () => {
    const html = markup();
    assert({
      given: 'the pane header',
      should: 'carry a New chat button and a control that hides the history',
      actual: [html.includes('aria-label="New chat"'), html.includes('aria-label="Hide Chat history"'), html.includes('>Chats<')],
      expected: [true, true, true],
    });
  });

  test('loading, failed and empty', () => {
    const loading = markup({ list: { status: 'loading' } });
    const failed = markup({ list: { status: 'error' } });
    const empty = markup({ list: { ...ready, days: [] } });
    assert({
      given: 'the list loading, failed and empty',
      should: 'say so in each case, offer to try a failed load again, and keep New chat available',
      actual: [
        loading.includes('role="status"') && loading.includes('Loading chats…'),
        failed.includes('role="alert"') && failed.includes('Could not load chats.') && failed.includes('Try again'),
        empty.includes('No chats yet.'),
        [loading, failed, empty].every((html) => html.includes('aria-label="New chat"')),
      ],
      expected: [true, true, true, true],
    });
  });

  test('older chats', () => {
    assert({
      given: 'a list with more pages, one loading, and one with none',
      should: 'offer the older chats, show it busy while loading, and offer nothing at the end',
      actual: [
        markup({ list: { ...ready, hasMore: true } }).includes('>Show older chats<'),
        markup({ list: { ...ready, hasMore: true, loadingMore: true } }).includes('disabled=""'),
        markup().includes('Show older chats'),
      ],
      expected: [true, true, false],
    });
  });
});
