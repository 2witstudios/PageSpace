// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';
import { ConversationHead } from './conversation-head';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/retained/components/moderation/UserSafetyMenu', async () => {
  const { createElement: h } = await import('react');
  return { UserSafetyMenu: (props: { triggerLabel?: string }) => h('button', { type: 'button', 'aria-label': props.triggerLabel }) };
});
vi.mock('../use-messages/use-messages', () => ({
  useDirectThreads: () => ({
    threads: [
      { kind: 'dm', id: 'c1', name: 'Dana Whitfield', otherUserId: 'u2', avatarUrl: null, lastMessageAt: null, lastMessagePreview: null, lastReadAt: null, unreadCount: 0 },
      { kind: 'dm', id: 'c2', name: 'PageSpace Support', otherUserId: 'u3', accountType: 'agent', avatarUrl: null, lastMessageAt: null, lastMessagePreview: null, lastReadAt: null, unreadCount: 0 },
    ],
  }),
}));

afterEach(unmountAll);

describe('ConversationHead', () => {
  test('one head: crumbs, options and the shell controls', () => {
    const container = mount(
      createElement(ConversationHead, { conversationId: 'c1', trailing: createElement('button', { type: 'button', 'aria-label': 'Close' }) }),
    );
    assert({
      given: 'an open DM with Dana',
      should: 'show "Direct messages › Dana Whitfield", Conversation options and Close, and no Share',
      actual: {
        crumbs: [...container.querySelectorAll('ol[aria-label="Path"] li')].map((item) => item.textContent?.replace('›', '').trim()),
        buttons: [...container.querySelectorAll('button')].map((button) => button.getAttribute('aria-label')),
      },
      expected: { crumbs: ['Direct messages', 'Dana Whitfield'], buttons: ['Conversation options', 'Close'] },
    });
  });

  test('a DM with an agent account marks the head (Agent Signup Phase 2c)', () => {
    const agent = mount(createElement(ConversationHead, { conversationId: 'c2' }));
    const human = mount(createElement(ConversationHead, { conversationId: 'c1' }));
    assert({
      given: 'open DMs with an agent and with a person',
      should: 'mark only the agent’s head',
      actual: [agent, human].map((container) => container.querySelector('[aria-label="AI agent account"]') !== null),
      expected: [true, false],
    });
  });
});
