// @vitest-environment jsdom
import { renderToString } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { assistantWithTool, userMessage } from '../chat-model/fixtures';
import type { ChatMessage } from '../chat-model/chat';
import type { ChatDensity } from '../../frame/stage/stage';
import { chatMessageClass } from './chat-message-class';
import { renderChatMessage } from './chat-message.render';

const dom = (message: ChatMessage, density: ChatDensity = 'roomy', streaming = false): HTMLElement => {
  const container = document.createElement('ol');
  container.innerHTML = renderToString(
    renderChatMessage({ message, density, assistantName: 'Imago', streaming, citationDriveId: 'd1' }),
  );
  return container;
};

describe('renderChatMessage()', () => {
  test('a user message', () => {
    const view = dom(userMessage('m1', 'What does the **roadmap** say?'));
    const item = view.querySelector('li');
    assert({
      given: 'the viewer’s message',
      should: 'be an accent-soft card saying who spoke to assistive technology, its markdown rendered',
      actual: [
        item?.className,
        item?.dataset.role,
        item?.querySelector('.sr-only')?.textContent,
        item?.querySelector('strong')?.textContent,
      ],
      expected: [chatMessageClass('user', 'roomy'), 'user', 'You said: ', 'roadmap'],
    });
  });

  test('an assistant reply', () => {
    const view = dom(assistantWithTool('m2'), 'dense');
    const item = view.querySelector('li');
    const children = [...(item?.children ?? [])].map((child) => child.tagName.toLowerCase());
    assert({
      given: 'a reply that called a tool, then wrote its answer, in the dense chat',
      should: 'be plain prose with no bubble, the tool call as one summary line before the answer',
      actual: [
        item?.className,
        item?.dataset.role,
        item?.querySelector('.sr-only')?.textContent,
        children,
        item?.querySelector('details summary')?.textContent?.includes('Read page'),
        item?.querySelector('p')?.textContent,
      ],
      expected: [
        chatMessageClass('assistant', 'dense'),
        'assistant',
        'Imago said: ',
        ['span', 'details', 'div'],
        true,
        'The roadmap says ship in October.',
      ],
    });
  });

  test('one summary per tool call', () => {
    const message: ChatMessage = {
      id: 'm3',
      role: 'assistant',
      parts: [
        { type: 'tool-list_pages', toolCallId: 'a', state: 'output-available', input: {}, output: [] },
        { type: 'tool-read_page', toolCallId: 'b', state: 'input-available', input: { title: 'Roadmap' } },
      ],
    };
    const view = dom(message);
    assert({
      given: 'a reply with two tool calls and no text yet',
      should: 'render two collapsed summary lines, one per call',
      actual: [...view.querySelectorAll('details')].map((details) => [details.dataset.tool, details.hasAttribute('open')]),
      expected: [
        ['done', false],
        ['running', false],
      ],
    });
  });

  test('streaming reply', () => {
    const message: ChatMessage = { id: 'm4', role: 'assistant', parts: [{ type: 'text', text: 'Half **bold' }] };
    assert({
      given: 'a reply still streaming, and the same reply finished',
      should: 'mark only the streaming one busy',
      actual: [dom(message, 'roomy', true).querySelector('li')?.getAttribute('aria-busy'), dom(message).querySelector('li')?.getAttribute('aria-busy')],
      expected: ['true', null],
    });
  });
});
