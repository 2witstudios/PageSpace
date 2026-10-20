// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '@/ui/test-support/dom';
import { getUiState, setUiState } from '@/ui/store/store';
import { dispatch, transactions } from '@/ui/store/transactions';
import type { TreePage } from '@/retained/hooks/usePageTree';
import { useSettingsSubnavStore } from '@/ui/files/settings-subnav/settings-subnav-store';
import { AgentPage, agentCategoryFrom, agentSettingsItems, agentViewFrom } from './agent-page';

vi.mock('@/retained-adapters/retained-chat', async () => {
  const { createElement: h } = await import('react');
  return {
    RetainedChat: (props: { agentId: string | null; conversationId: string | null; isolated?: boolean }) =>
      h('div', {
        'data-testid': 'retained-chat',
        'data-agent': props.agentId,
        'data-conversation': props.conversationId,
        'data-isolated': String(props.isolated === true),
      }),
  };
});

vi.mock('@/retained-adapters/link', async () => {
  const { createElement: h } = await import('react');
  return {
    default: (props: { href: string; className?: string; children?: unknown }) =>
      h('a', { href: props.href, className: props.className }, props.children as never),
  };
});

vi.mock('@/retained-adapters/agent-settings', async () => {
  const { createElement: h } = await import('react');
  return {
    AgentSettings: (props: { pageId: string; category: string; categoryTitle: string }) =>
      h('div', { 'data-testid': 'agent-settings', 'data-agent': props.pageId, 'data-category': props.category, 'data-title': props.categoryTitle }),
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
  useSettingsSubnavStore.setState({ open: true });
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

describe('AgentPage entry and the Imago column (IMC-3.11)', () => {
  test('leaves Imago open and selects this agent for the side chat', () => {
    dispatch(transactions.expandImago, undefined);
    mount(createElement(AgentPage, props));
    assert({
      given: 'the viewer entering an agent page with Imago open',
      should: 'keep Imago docked and point the side chat at this agent',
      actual: { collapsed: getUiState().resources.imagoCollapsed, agent: getUiState().resources.chatAgent },
      expected: { collapsed: false, agent: { id: 'a1', title: 'Launch Agent' } },
    });
  });

  test('hands the side chat back to its agent on leaving the page', () => {
    dispatch(transactions.selectAgent, null);
    mount(createElement(AgentPage, props));
    unmountAll();
    assert({
      given: 'Imago talking as Imago, then an agent page entered and left',
      should: 'leave the side chat with Imago again',
      actual: getUiState().resources.chatAgent,
      expected: null,
    });
  });

  test('keeps the middle chat isolated from the Imago column', () => {
    const container = mount(createElement(AgentPage, props));
    assert({
      given: 'the Chat tab of an agent page',
      should: 'mount the chat isolated from the shared selection',
      actual: container.querySelector('[data-testid="retained-chat"]')?.getAttribute('data-isolated'),
      expected: 'true',
    });
  });

  test('leaves Imago where the viewer put it on entering another agent page', () => {
    setUiState({ ...getUiState(), resources: { ...getUiState().resources, imagoCollapsed: true } });
    mount(createElement(AgentPage, { ...props, pageId: 'a2', page: { ...page, id: 'a2' } as TreePage }));
    const collapsedByViewer = getUiState().resources.imagoCollapsed;
    unmountAll();
    setUiState({ ...getUiState(), resources: { ...getUiState().resources, imagoCollapsed: false } });
    mount(createElement(AgentPage, { ...props, pageId: 'a3', page: { ...page, id: 'a3' } as TreePage }));
    assert({
      given: 'Imago folded by the viewer, then open, as another agent page is entered',
      should: 'neither unfold nor fold it',
      actual: [collapsedByViewer, getUiState().resources.imagoCollapsed],
      expected: [true, false],
    });
  });
});

describe('agentCategoryFrom', () => {
  test('reads a known category from the URL and falls back to Behavior', () => {
    assert({
      given: 'the category values tools, a made-up value and none',
      should: 'name the matching category, with Behavior as the fallback',
      actual: ['tools', 'nope', null].map(agentCategoryFrom),
      expected: ['tools', 'behavior', 'behavior'],
    });
  });
});

describe('AgentPage settings sub-nav', () => {
  const settingsNav = (container: HTMLElement) => container.querySelector('nav[aria-label="Agent settings"]');
  const navRows = (container: HTMLElement) =>
    Array.from(settingsNav(container)?.querySelectorAll<HTMLButtonElement>('button:not([aria-label])') ?? []);

  test('renders a persistent Agent settings nav beside the Behavior form by default', () => {
    window.history.replaceState(null, '', '/?tab=settings');
    const container = mount(createElement(AgentPage, props));
    assert({
      given: 'the Settings tab with no category in the URL',
      should: 'render the Agent settings nav with Behavior current and its form beside it',
      actual: {
        nav: settingsNav(container) !== null,
        current: navRows(container).map((row) => row.getAttribute('aria-current')),
        form: container.querySelector('[data-testid="agent-settings"]')?.getAttribute('data-category'),
      },
      expected: { nav: true, current: ['page', null, null, null, null], form: 'behavior' },
    });
  });

  test('opens the category named in the URL', () => {
    window.history.replaceState(null, '', '/?tab=settings&category=tools');
    const container = mount(createElement(AgentPage, props));
    assert({
      given: 'a page address carrying category=tools',
      should: 'mark the Tools row current and pass tools to the form',
      actual: {
        current: navRows(container).map((row) => row.getAttribute('aria-current')),
        form: container.querySelector('[data-testid="agent-settings"]')?.getAttribute('data-category'),
        title: container.querySelector('[data-testid="agent-settings"]')?.getAttribute('data-title'),
      },
      expected: { current: [null, null, 'page', null, null], form: 'tools', title: 'Tools' },
    });
  });

  test('selecting a row shows that category and writes it to the URL', () => {
    window.history.replaceState(null, '', '/?tab=settings');
    const container = mount(createElement(AgentPage, props));
    const access = navRows(container)[1];
    if (access) click(access);
    assert({
      given: 'a click on the Access row',
      should: 'show the Access form and write category=access into the URL',
      actual: {
        form: container.querySelector('[data-testid="agent-settings"]')?.getAttribute('data-category'),
        url: new URL(window.location.href).searchParams.get('category'),
        tab: new URL(window.location.href).searchParams.get('tab'),
      },
      expected: { form: 'access', url: 'access', tab: 'settings' },
    });
  });

  test('collapses to a Show settings menu button and back', () => {
    window.history.replaceState(null, '', '/?tab=settings');
    const container = mount(createElement(AgentPage, props));
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close settings menu"]');
    if (close) click(close);
    const collapsed = {
      nav: settingsNav(container) === null,
      show: container.querySelector('button[aria-label="Show settings menu"]') !== null,
      form: container.querySelector('[data-testid="agent-settings"]') !== null,
    };
    const show = container.querySelector<HTMLButtonElement>('button[aria-label="Show settings menu"]');
    if (show) click(show);
    assert({
      given: 'Close settings menu then Show settings menu',
      should: 'hide the nav with the form still shown, then bring the nav back',
      actual: { collapsed, reopened: settingsNav(container) !== null },
      expected: { collapsed: { nav: true, show: true, form: true }, reopened: true },
    });
  });
});
