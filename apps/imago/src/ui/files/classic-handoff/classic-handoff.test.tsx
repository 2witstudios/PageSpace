// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { click, mount, unmountAll } from '../../test-support/dom';
import { fakeWeb, type FakeRoute } from '../../test-support/fake-web';
import { createInitialState } from '../../store/state';
import { getUiState, setUiState } from '../../store/store';
import { stageFor } from '../../frame/stage/stage';
import { chatPaths } from '../../chat/chat-api/chat-api';
import { agentConversation, conversationsPage, driveAgentsBody, messagesPage, pointers, userMessage } from '../../chat/chat-model/fixtures';
import { ChatPane } from '../../chat/chat-pane/chat-pane';

// The router is Next's seam: switching to the chat is a push to the drive's chat address.
const router = vi.hoisted(() => ({ pushed: [] as string[] }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: (href: string) => router.pushed.push(href) }),
}));

const { ClassicHandoff } = await import('./classic-handoff');

beforeEach(() => {
  setUiState(createInitialState());
  router.pushed = [];
});

afterEach(unmountAll);

const PAGE = 'GET /api/pages/p1';

const page = (type: string, overrides: Record<string, unknown> = {}): FakeRoute => () =>
  Response.json({ id: 'p1', title: 'Q3 numbers', type, driveId: 'd1', isTrashed: false, ...overrides });

const settle = (check: () => void): Promise<void> =>
  act(() => vi.waitFor(check, { timeout: 1000, interval: 5 }));

/** The handoff as the route holds it, optionally beside the shell's chat pane at the files address. */
const show = (routes: Record<string, FakeRoute>, { withChat = false } = {}) => {
  const web = fakeWeb(routes);
  const container = mount(
    <ImagoSWRProvider client={web.client}>
      <ClassicHandoff driveId="d1" pageId="p1">
        <p data-page-content="">the page</p>
      </ClassicHandoff>
      {withChat ? <ChatPane stage={stageFor('/d1/files/p1')} driveName="Alpha" homeDriveId="home-1" /> : null}
    </ImagoSWRProvider>,
  );
  return { web, container };
};

const card = (container: HTMLElement) => container.querySelector('[data-handoff]');

const cardParts = (container: HTMLElement) => {
  const element = card(container);
  const classic = element?.querySelector('a');
  return [
    element?.querySelector('[data-handoff-type]')?.textContent,
    element?.querySelector('h2')?.textContent,
    classic?.textContent,
    classic?.getAttribute('href'),
    [...(element?.querySelectorAll('button') ?? [])].map((button) => button.textContent),
  ];
};

const chatButton = (container: HTMLElement): HTMLButtonElement => {
  const button = [...container.querySelectorAll('[data-handoff] button')].find((entry) => entry.textContent === 'Chat with this agent');
  if (!(button instanceof HTMLButtonElement)) throw new Error('no Chat with this agent');
  return button;
};

describe('ClassicHandoff', () => {
  test('page types imago does not render', async () => {
    const cases = [
      ['SHEET', 'Sheet'],
      ['CANVAS', 'Canvas'],
      ['CODE', 'Code'],
      ['FILE', 'File'],
      ['TASK_LIST', 'Task List'],
    ] as const;
    const actual: unknown[] = [];
    for (const [type] of cases) {
      const { container } = show({ [PAGE]: page(type) });
      await settle(() => {
        if (!card(container)) throw new Error(`${type}: no card`);
      });
      actual.push([...cardParts(container), container.querySelector('[data-page-content]')]);
      unmountAll();
    }
    assert({
      given: 'a sheet, a canvas, a code page, a file and a task list opened in Files',
      should: 'draw an object card with the type, the title and Open in classic to the classic page, instead of the page view',
      actual,
      expected: cases.map(([, label]) => [label, 'Q3 numbers', 'Open in classic', '/dashboard/d1/p1', [], null]),
    });
  });

  test('page types imago renders itself', async () => {
    const actual: unknown[] = [];
    for (const type of ['DOCUMENT', 'FOLDER', 'CHANNEL']) {
      const { container } = show({ [PAGE]: page(type) });
      await settle(() => {
        if (!container.querySelector('[data-page-content]')) throw new Error(`${type}: no page`);
      });
      actual.push([type, card(container)]);
      unmountAll();
    }
    assert({
      given: 'a document, a folder and a channel',
      should: 'draw the page’s own view and no card',
      actual,
      expected: [
        ['DOCUMENT', null],
        ['FOLDER', null],
        ['CHANNEL', null],
      ],
    });
  });

  test('an agent page', async () => {
    const { container } = show({ [PAGE]: page('AI_CHAT', { title: 'Support' }) });
    await settle(() => {
      if (!card(container)) throw new Error('no card');
    });
    const parts = cardParts(container);
    click(chatButton(container));
    assert({
      given: 'an AI chat page, then Chat with this agent',
      should: 'offer the chat and classic, then choose that agent in the chat header’s state and switch to the drive’s chat',
      actual: [parts, getUiState().resources.chatAgent, getUiState().resources.chatConversationId, router.pushed],
      expected: [
        ['AI Chat', 'Support', 'Open in classic', '/dashboard/d1/p1', ['Chat with this agent']],
        { id: 'p1', title: 'Support' },
        null,
        ['/d1'],
      ],
    });
  });
});

describe('Chat with this agent, through the chat header', () => {
  const AGENT_CONVERSATIONS = `GET ${chatPaths.conversations('p1', 0)}`;
  const chatRoutes = (agentConversations: FakeRoute): Record<string, FakeRoute> => ({
    [PAGE]: page('AI_CHAT', { title: 'Support' }),
    [`GET ${chatPaths.builtinAgents}`]: () => Response.json(pointers()),
    [`GET ${chatPaths.conversations('p-imago', 0)}`]: () => Response.json(conversationsPage([agentConversation('c1')])),
    [`GET ${chatPaths.messages('p-imago', 'c1')}`]: () => Response.json(messagesPage([userMessage('m1', 'Hello Imago')])),
    [`GET ${chatPaths.driveAgents('d1')}`]: () => Response.json(driveAgentsBody([{ id: 'p1', title: 'Support' }])),
    [AGENT_CONVERSATIONS]: agentConversations,
    [`GET ${chatPaths.messages('p1', 'k1')}`]: () =>
      Response.json(messagesPage([userMessage('s1', 'Any open tickets?')], { conversationId: 'k1' })),
    'GET /api/pages/p1/breadcrumbs': () => Response.json([{ id: 'p1', title: 'Support', type: 'AI_CHAT', parentId: null }]),
  });

  const picker = (container: HTMLElement) => container.querySelector('header select');

  test('an agent the viewer can use', async () => {
    const { container } = show(chatRoutes(() => Response.json(conversationsPage([agentConversation('k1')]))), { withChat: true });
    await settle(() => {
      if (!container.textContent?.includes('Hello Imago')) throw new Error('Imago thread not loaded');
    });
    click(chatButton(container));
    await settle(() => {
      if (!container.textContent?.includes('Any open tickets?')) throw new Error('agent thread not loaded');
    });
    assert({
      given: 'Chat with this agent beside the chat pane',
      should: 'show the agent chosen in the header and its latest conversation',
      actual: [(picker(container) as HTMLSelectElement | null)?.value, container.textContent?.includes('Hello Imago')],
      expected: ['p1', false],
    });
  });

  test('an agent the server refuses', async () => {
    const { container } = show(
      chatRoutes(() => Response.json({ error: 'Insufficient permissions to view this agent' }, { status: 403 })),
      { withChat: true },
    );
    await settle(() => {
      if (!container.textContent?.includes('Hello Imago')) throw new Error('Imago thread not loaded');
    });
    click(chatButton(container));
    await settle(() => {
      if (container.querySelector('[role="alert"]') === null) throw new Error('no notice');
    });
    assert({
      given: 'Chat with this agent for an agent the server answers 403 for',
      should: 'fall back to Imago with the chat header’s lost-access notice',
      actual: [
        container.querySelector('[role="alert"]')?.textContent,
        (picker(container) as HTMLSelectElement | null)?.value,
        getUiState().resources.chatAgent,
      ],
      expected: ['You no longer have access to Support, so Imago is answering.', 'p-imago', null],
    });
  });
});
