// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '@/ui/test-support/dom';
import type { TreePage } from '@/retained/hooks/usePageTree';
import { AgentPage, agentSettingsItems, agentViewFrom } from './agent-page';

vi.mock('@/retained-adapters/retained-chat', async () => {
  const { createElement: h } = await import('react');
  return {
    RetainedChat: (props: { agentId: string | null; conversationId: string | null }) =>
      h('div', { 'data-testid': 'retained-chat', 'data-agent': props.agentId, 'data-conversation': props.conversationId }),
  };
});

vi.mock('@/retained-adapters/link', async () => {
  const { createElement: h } = await import('react');
  return {
    default: (props: { href: string; className?: string; children?: unknown }) =>
      h('a', { href: props.href, className: props.className }, props.children as never),
  };
});

vi.mock('@/ui/chat/use-chat-data/use-chat-data', () => ({
  useAgentConversations: () => ({
    conversations: [
      {
        id: 'c1',
        title: 'What is still blocking the beta?',
        preview: 'Two items: the status page copy and the invite-flow load test.',
        createdAt: '2026-10-11T09:00:00.000Z',
        updatedAt: '2026-10-11T09:00:00.000Z',
        messageCount: 4,
        isShared: true,
        isOwner: true,
        sessionId: null,
        lastMessage: { role: 'assistant', timestamp: '2026-10-11T09:00:00.000Z' },
      },
      {
        id: 'c2',
        title: 'Draft the waitlist email',
        preview: 'Here is a first pass in Brand Voice.',
        createdAt: '2026-10-10T09:00:00.000Z',
        updatedAt: '2026-10-10T09:00:00.000Z',
        messageCount: 2,
        isShared: false,
        isOwner: true,
        sessionId: null,
        lastMessage: { role: 'assistant', timestamp: '2026-10-10T09:00:00.000Z' },
      },
    ],
    revalidate: async () => undefined,
    isLoading: false,
  }),
}));

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

afterEach(unmountAll);

const page = { id: 'a1', driveId: 'd1', title: 'Launch Agent', type: 'AI_CHAT' } as unknown as TreePage;
const props = { page, driveId: 'd1', pageId: 'a1' };

const strip = (container: HTMLElement) => container.querySelector('[role="toolbar"][aria-label="Agent views"]');
const tabs = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tablist"][aria-label="Agent"] [role="tab"]'));

describe('agentViewFrom', () => {
  test('reads a known tab from the URL and falls back to Chat', () => {
    assert({
      given: 'the tab values chat, history, settings, an unknown value and none',
      should: 'name the matching view, with Chat as the fallback',
      actual: ['history', 'settings', 'nope', null].map(agentViewFrom),
      expected: ['history', 'settings', 'chat', 'chat'],
    });
  });
});

describe('agentSettingsItems', () => {
  test('lists the five categories in board order', () => {
    assert({
      given: 'the Settings tab rows',
      should: 'list Behavior, Access, Tools, Integrations and Accounts with the board copy',
      actual: agentSettingsItems().map((item) => item.title),
      expected: ['Behavior', 'Access', 'Tools', 'Integrations', 'Accounts'],
    });
  });
});

describe('AgentPage', () => {
  test('renders the 44px Agent views strip with Chat, History and settings tabs', () => {
    const container = mount(createElement(AgentPage, props));
    assert({
      given: 'an agent page',
      should: 'render the Agent views toolbar with a tablist named Agent',
      actual: {
        toolbar: strip(container) !== null,
        tabs: tabs(container).map((button) => button.textContent),
      },
      expected: { toolbar: true, tabs: ['Chat', 'History', 'Launch Agent settings'] },
    });
  });

  test('offers Open in Agents and Start a new conversation in the strip', () => {
    const container = mount(createElement(AgentPage, props));
    const toolbar = strip(container);
    assert({
      given: 'an agent page',
      should: 'show Open in Agents and a Start a new conversation button',
      actual: {
        openInAgents: Array.from(toolbar?.querySelectorAll('a') ?? []).some((a) => a.textContent === 'Open in Agents'),
        newConversation: toolbar?.querySelector('button[aria-label="Start a new conversation"]') !== null,
      },
      expected: { openInAgents: true, newConversation: true },
    });
  });

  test('opens on the Chat tab and selects the tab in the URL', () => {
    const container = mount(createElement(AgentPage, props));
    const history = tabs(container)[1];
    if (history) click(history);
    assert({
      given: 'a click on the History tab',
      should: 'mark History selected and write tab=history into the URL',
      actual: {
        selected: tabs(container).map((button) => button.getAttribute('aria-selected')),
        url: new URL(window.location.href).searchParams.get('tab'),
      },
      expected: { selected: ['false', 'true', 'false'], url: 'history' },
    });
  });

  test('shows the Chat view with no conversation until one is picked', () => {
    const container = mount(createElement(AgentPage, props));
    const chat = container.querySelector('[data-testid="retained-chat"]');
    assert({
      given: 'a fresh agent page on the Chat tab',
      should: 'mount the chat for this agent with no conversation selected',
      actual: { agent: chat?.getAttribute('data-agent'), conversation: chat?.getAttribute('data-conversation') },
      expected: { agent: 'a1', conversation: null },
    });
  });

  test('lists conversations with title, preview, a Shared switch and Delete on the History tab', () => {
    window.history.replaceState(null, '', '/?tab=history');
    const container = mount(createElement(AgentPage, props));
    const text = container.textContent ?? '';
    const shared = container.querySelector('button[role="switch"][aria-label="Share What is still blocking the beta?"]');
    const deleteButton = container.querySelector('button[aria-label="Delete Draft the waitlist email"]');
    assert({
      given: 'the History tab with two conversations',
      should: 'show the heading, previews, a Shared switch per owned conversation and a Delete button',
      actual: {
        heading: text.includes('Conversations'),
        preview: text.includes('Here is a first pass in Brand Voice.'),
        sharedOn: shared?.getAttribute('aria-checked'),
        deleteButton: deleteButton !== null,
      },
      expected: { heading: true, preview: true, sharedOn: 'true', deleteButton: true },
    });
  });

  test('restores the tab named in the URL on mount', () => {
    window.history.replaceState(null, '', '/?tab=settings');
    const container = mount(createElement(AgentPage, props));
    assert({
      given: 'a page address carrying tab=settings',
      should: 'open the Settings tab',
      actual: tabs(container).map((button) => button.getAttribute('aria-selected')),
      expected: ['false', 'false', 'true'],
    });
  });

  test('renders the five category rows on the Settings tab', () => {
    window.history.replaceState(null, '', '/?tab=settings');
    const container = mount(createElement(AgentPage, props));
    const text = container.textContent ?? '';
    assert({
      given: 'the Settings tab',
      should: 'render the Agent settings heading and the five category rows',
      actual: {
        heading: text.includes('Agent settings'),
        rows: ['Behavior', 'Access', 'Tools', 'Integrations', 'Accounts'].every((title) => text.includes(title)),
      },
      expected: { heading: true, rows: true },
    });
  });

  test('does not mount the chat on the Settings tab', () => {
    window.history.replaceState(null, '', '/?tab=settings');
    const container = mount(createElement(AgentPage, props));
    assert({
      given: 'the Settings tab',
      should: 'not render the chat in the Settings view',
      actual: container.querySelector('[data-testid="retained-chat"]'),
      expected: null,
    });
  });
});
