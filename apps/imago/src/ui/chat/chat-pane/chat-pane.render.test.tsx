// @vitest-environment jsdom
import { renderToString } from 'react-dom/server';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { assistantWithTool, userMessage } from '../chat-model/fixtures';
import { chatMessageClass } from '../chat-message/chat-message-class';
import {
  chatChipClass,
  chatEmptyClass,
  chatNoticeClass,
  chatPaneClass,
  chatThreadClass,
} from './chat-pane-class';
import { click, mount, unmountAll } from '../../test-support/dom';
import { renderChatPane, type ChatPaneRenderProps } from './chat-pane.render';

const props = (overrides: Partial<ChatPaneRenderProps> = {}): ChatPaneRenderProps => ({
  density: 'roomy',
  agentName: 'Imago',
  contextLabel: 'Alpha in context',
  messages: [],
  streamingMessageId: null,
  notice: null,
  citationDriveId: 'd1',
  composer: <form data-composer="" />,
  picker: <details data-picker="" />,
  onHistory: () => {},
  onNewChat: () => {},
  ...overrides,
});

const dom = (overrides: Partial<ChatPaneRenderProps> = {}): HTMLElement => {
  const container = document.createElement('div');
  container.innerHTML = renderToString(renderChatPane(props(overrides)));
  return container;
};

const headLabels = (header: Element | null | undefined) =>
  [...(header?.children ?? [])].map((child) => child.getAttribute('aria-label') ?? child.getAttribute('class') ?? child.tagName.toLowerCase());

afterEach(unmountAll);

describe('renderChatPane()', () => {
  test('roomy', () => {
    const view = dom();
    const pane = view.querySelector('aside');
    assert({
      given: 'the drive chat, roomy',
      should: 'label the tinted Imago column, head it with the picker, centre the thread and float the composer below it',
      actual: [
        pane?.getAttribute('aria-label'),
        pane?.dataset.density,
        pane?.className,
        pane?.querySelector('header')?.firstElementChild?.hasAttribute('data-picker'),
        pane?.querySelector('header select'),
        pane?.querySelector('ol')?.className,
        pane?.lastElementChild?.hasAttribute('data-composer'),
      ],
      expected: ['Imago', 'roomy', chatPaneClass('roomy'), true, null, chatThreadClass('roomy'), true],
    });
  });

  test('dense beside an object', () => {
    const view = dom({ density: 'dense', contextLabel: 'Roadmap in context', chip: 'Roadmap' });
    const chip = view.querySelector('header > span:not(.flex-1)');
    assert({
      given: 'a page open beside the chat',
      should: 'pack the thread densely and name the open object, bare, in the context chip',
      actual: [
        view.querySelector('aside')?.dataset.density,
        view.querySelector('aside')?.className,
        view.querySelector('ol')?.className,
        [chip?.className, chip?.textContent],
      ],
      expected: ['dense', chatPaneClass('dense'), chatThreadClass('dense'), [chatChipClass, 'Roadmap']],
    });
  });

  test('head controls', () => {
    const view = dom({
      leading: <button type="button" aria-label="Show sidebar" />,
      trailing: <button type="button" aria-label="Collapse Imago" />,
      chip: 'Files',
    });
    const header = view.querySelector('aside > header');
    assert({
      given: 'a leading Show sidebar, the context chip and a trailing Collapse Imago',
      should: 'lay out Show sidebar · picker · chip · flex · History · New chat · Collapse Imago',
      actual: headLabels(header),
      expected: ['Show sidebar', 'details', chatChipClass, 'flex-1', 'Chat history', 'New chat', 'Collapse Imago'],
    });
  });

  test('no head controls', () => {
    const header = dom({ chip: null }).querySelector('aside > header');
    const empty = dom({ chip: '' }).querySelector('aside > header');
    assert({
      given: 'neither a leading nor a trailing control, and no context (the chat home), null or empty',
      should: 'render the picker, History and New chat alone, with no chip',
      actual: [headLabels(header), headLabels(empty)],
      expected: [
        ['details', 'flex-1', 'Chat history', 'New chat'],
        ['details', 'flex-1', 'Chat history', 'New chat'],
      ],
    });
  });

  test('a thread', () => {
    const view = dom({ messages: [userMessage('m1', 'Hi'), assistantWithTool('m2')], streamingMessageId: 'm2' });
    const items = [...view.querySelectorAll('ol > li')];
    assert({
      given: 'a user message and a reply still streaming',
      should: 'render the card and the prose in order, the streaming reply marked busy',
      actual: items.map((item) => [item.className, item.getAttribute('aria-busy')]),
      expected: [
        [chatMessageClass('user', 'roomy'), null],
        [chatMessageClass('assistant', 'roomy'), 'true'],
      ],
    });
  });

  test('empty, loading and notices', () => {
    const empty = dom();
    const loading = dom({ messages: undefined });
    const failed = dom({ notice: 'The reply failed. Try again.' });
    assert({
      given: 'an empty conversation, one still loading, and a failed turn',
      should: 'invite a first message, mark the thread busy, and say what failed as an alert',
      actual: [
        [empty.querySelector('ol > li')?.className, empty.querySelector('ol > li')?.textContent],
        [loading.querySelector('ol')?.getAttribute('aria-busy'), loading.querySelectorAll('ol > li').length],
        [failed.querySelector('[role="alert"]')?.textContent, failed.querySelector('[role="alert"]')?.className],
      ],
      expected: [
        [chatEmptyClass, 'Ask Imago anything. Open a page only when the work needs it.'],
        ['true', 0],
        ['The reply failed. Try again.', chatNoticeClass],
      ],
    });
  });

  test('History and New chat', () => {
    const pressed: string[] = [];
    const closed = mount(renderChatPane(props({ onHistory: () => pressed.push('history'), onNewChat: () => pressed.push('new') })));
    const open = dom({ historyOpen: true });
    const history = closed.querySelector<HTMLButtonElement>('button[aria-label="Chat history"]');
    const newChat = closed.querySelector<HTMLButtonElement>('button[aria-label="New chat"]');
    if (history === null || newChat === null) throw new Error('no head buttons');
    click(history);
    click(newChat);
    assert({
      given: 'the head’s History and New chat, the History view closed and then open, each pressed',
      should: 'title History, press it only while the view shows, and call each handler',
      actual: [
        [history.getAttribute('title'), history.getAttribute('aria-pressed'), history.type],
        open.querySelector('button[aria-label="Chat history"]')?.getAttribute('aria-pressed'),
        [newChat.getAttribute('title'), newChat.type],
        pressed,
      ],
      expected: [['History', 'false', 'button'], 'true', ['New chat', 'button'], ['history', 'new']],
    });
  });

  test('a hosted chat surface', () => {
    const view = dom({ content: <div data-retained-host="" />, notice: 'This chat could not load. Try again in a moment.' });
    const pane = view.querySelector('aside');
    assert({
      given: 'the reused chat surface and a notice',
      should: 'say the notice as an alert above the surface, with no thread of its own',
      actual: [
        [...(pane?.children ?? [])].map((child) => child.tagName.toLowerCase()),
        pane?.querySelector('[role="alert"]')?.textContent,
        pane?.querySelector('ol'),
      ],
      expected: [['header', 'p', 'div'], 'This chat could not load. Try again in a moment.', null],
    });
  });
});
