// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, beforeEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '../../test-support/dom';
import { getUiState, setUiState } from '@/ui/store/store';
import { SIDE_CHAT_SUGGESTIONS, SideChatEmpty, sideChatLine } from './side-chat-empty';

beforeEach(() => {
  setUiState({ ...getUiState(), resources: { ...getUiState().resources, chatDraft: '' } });
});

afterEach(unmountAll);

describe('sideChatLine()', () => {
  test('names the agent and says how to get Imago back', () => {
    assert({
      given: 'the agent Launch Agent',
      should: 'say it is a side chat, why it is handy, and where Imago is',
      actual: sideChatLine('Launch Agent'),
      expected: 'Side chat with Launch Agent — handy when the main chat is busy. Switch to Imago from the name above.',
    });
  });
});

describe('SideChatEmpty', () => {
  test('offers the two board suggestions', () => {
    assert({
      given: 'an empty side chat',
      should: 'offer Summarize this conversation and What are you working on?',
      actual: [...SIDE_CHAT_SUGGESTIONS],
      expected: ['Summarize this conversation', 'What are you working on?'],
    });
  });

  test('shows the line and a chip per suggestion', () => {
    const container = mount(createElement(SideChatEmpty, { agentName: 'Launch Agent' }));
    assert({
      given: 'the side chat for Launch Agent',
      should: 'render the invitation line and both suggestion chips',
      actual: {
        line: container.textContent?.includes('Side chat with Launch Agent') ?? false,
        chips: Array.from(container.querySelectorAll('button')).map((button) => button.textContent),
      },
      expected: { line: true, chips: ['Summarize this conversation', 'What are you working on?'] },
    });
  });

  test('a chip seeds the composer with its text and does not send', () => {
    const container = mount(createElement(SideChatEmpty, { agentName: 'Launch Agent' }));
    const chip = container.querySelectorAll('button')[1];
    if (chip) click(chip);
    assert({
      given: 'a click on What are you working on?',
      should: 'fill the chat draft with that text',
      actual: getUiState().resources.chatDraft,
      expected: 'What are you working on?',
    });
  });
});
