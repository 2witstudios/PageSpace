// @vitest-environment jsdom
import { renderToString } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { assistantWithTool, userMessage } from '../chat-model/fixtures';
import { chatMessageClass } from '../chat-message/chat-message-class';
import {
  chatContextLabelClass,
  chatEmptyClass,
  chatNoticeClass,
  chatPaneClass,
  chatThreadClass,
} from './chat-pane-class';
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
  ...overrides,
});

const dom = (overrides: Partial<ChatPaneRenderProps> = {}): HTMLElement => {
  const container = document.createElement('div');
  container.innerHTML = renderToString(renderChatPane(props(overrides)));
  return container;
};

describe('renderChatPane()', () => {
  test('roomy', () => {
    const view = dom();
    const pane = view.querySelector('section');
    assert({
      given: 'the drive chat, roomy',
      should: 'label the pane, name the agent and the context in its header, centre the thread and float the composer below it',
      actual: [
        pane?.getAttribute('aria-label'),
        pane?.dataset.density,
        pane?.className,
        pane?.querySelector('header')?.textContent,
        pane?.querySelector('header small')?.className,
        pane?.querySelector('ol')?.className,
        pane?.lastElementChild?.hasAttribute('data-composer'),
      ],
      expected: ['Chat', 'roomy', chatPaneClass('roomy'), 'Imago/Alpha in context', chatContextLabelClass, chatThreadClass('roomy'), true],
    });
  });

  test('dense beside an object', () => {
    const view = dom({ density: 'dense', contextLabel: 'Roadmap in context' });
    assert({
      given: 'a page open beside the chat',
      should: 'pack the thread densely and name the open object in the header',
      actual: [
        view.querySelector('section')?.dataset.density,
        view.querySelector('section')?.className,
        view.querySelector('ol')?.className,
        view.querySelector('header small')?.textContent,
      ],
      expected: ['dense', chatPaneClass('dense'), chatThreadClass('dense'), 'Roadmap in context'],
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
});
