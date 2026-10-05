// @vitest-environment jsdom
import { act } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { fakeWeb, type FakeRoute } from '@/ui/test-support/fake-web';
import { fakeTurnStream, type FakeTurnStream } from '@/ui/test-support/fake-turn-stream';
import { click, mount, unmountAll } from '@/ui/test-support/dom';
import { getUiState, setUiState } from '@/ui/store/store';
import { createInitialState } from '@/ui/store/state';
import { dispatch, transactions } from '@/ui/store/transactions';
import { stageFor } from '@/ui/frame/stage/stage';
import { chatPaths } from '../chat-api/chat-api';
import { agentConversation, assistantWithTool, conversationsPage, driveAgentsBody, messagesPage, pointers, userMessage } from '../chat-model/fixtures';
import { ChatPane } from '../chat-pane/chat-pane';
import { ChatHistory } from './chat-history';

const AGENTS = `GET ${chatPaths.builtinAgents}`;
const CONVERSATIONS = `GET ${chatPaths.conversations('p-imago', 0)}`;
const OLDER_CONVERSATIONS = `GET ${chatPaths.conversations('p-imago', 1)}`;
const NEW_CONVERSATION = `POST ${chatPaths.newConversation('p-imago')}`;
const MESSAGES = (id: string) => `GET ${chatPaths.messages('p-imago', id)}`;
const TURN = `POST ${chatPaths.turn}`;
const DRIVE_AGENTS = `GET ${chatPaths.driveAgents('d1')}`;
const SUPPORT_CONVERSATIONS = `GET ${chatPaths.conversations('a-support', 0)}`;

// Days are the viewer's: run far from UTC, at 08:30 on Oct 5 in Los Angeles.
const zone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/Los_Angeles';
});
afterAll(() => {
  process.env.TZ = zone;
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-05T15:30:00.000Z'));
  setUiState(createInitialState());
});

afterEach(() => {
  unmountAll();
  vi.useRealTimers();
});

const settle = (check: () => void, timeout = 1000): Promise<void> =>
  vi.waitFor(
    async () => {
      await act(async () => {});
      check();
    },
    { timeout, interval: 5 },
  );

/** Newest first, as the route lists them: two today (one just after local midnight), one yesterday evening, one in September. */
const LISTED = [
  agentConversation('c3', { title: 'Q3 launch', updatedAt: '2026-10-05T15:00:00.000Z' }),
  agentConversation('c2', { title: 'Early bird', updatedAt: '2026-10-05T07:05:00.000Z' }),
  agentConversation('c1', { title: 'Roadmap review', updatedAt: '2026-10-05T06:55:00.000Z' }),
  agentConversation('c0', { title: 'Hiring plan', updatedAt: '2026-09-18T18:00:00.000Z' }),
];

const thread = (id: string, text: string) => Response.json(messagesPage([userMessage(`${id}-u`, text), { ...assistantWithTool(`${id}-a`) }], { conversationId: id }));

const historyWeb = (stream: FakeTurnStream, extra: Record<string, FakeRoute> = {}) =>
  fakeWeb({
    [AGENTS]: () => Response.json(pointers()),
    [CONVERSATIONS]: () => Response.json(conversationsPage([...LISTED])),
    [MESSAGES('c3')]: () => thread('c3', 'When does Q3 launch?'),
    [MESSAGES('c1')]: () => thread('c1', 'Review the roadmap'),
    [TURN]: () => stream.response(),
    [DRIVE_AGENTS]: () => Response.json(driveAgentsBody([{ id: 'a-support', title: 'Support' }])),
    ...extra,
  });

type Web = ReturnType<typeof historyWeb>;

/** The history in the list slot beside the chat pane, as the shell holds them. */
const mountChat = (web: Web) =>
  mount(
    <ImagoSWRProvider client={web.client}>
      <div data-slot="list">
        <ChatHistory />
      </div>
      <div data-slot="chat">
        <ChatPane stage={stageFor('/d1')} driveName="Alpha" homeDriveId="home-1" />
      </div>
    </ImagoSWRProvider>,
  );

const history = (container: HTMLElement): HTMLElement => {
  const element = container.querySelector('[data-slot="list"] section[aria-label="Chat history"]');
  if (!(element instanceof HTMLElement)) throw new Error('no history');
  return element;
};

const groups = (container: HTMLElement) =>
  [...history(container).querySelectorAll('section[aria-label]')].map((group) => [
    group.querySelector('h2')?.textContent,
    [...group.querySelectorAll('button')].map((row) => row.textContent),
  ]);

const row = (container: HTMLElement, title: string): HTMLButtonElement => {
  const found = [...history(container).querySelectorAll('li button')].find((button) => button.textContent === title);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`no row ${title}`);
  return found;
};

const current = (container: HTMLElement) =>
  [...history(container).querySelectorAll('[aria-current="true"]')].map((element) => element.textContent);

const control = (container: HTMLElement, label: string): HTMLButtonElement => {
  const found = container.querySelector(`button[aria-label="${label}"]`);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`no ${label}`);
  return found;
};

const composer = (container: HTMLElement): HTMLTextAreaElement => {
  const element = container.querySelector('[data-slot="chat"] textarea');
  if (!(element instanceof HTMLTextAreaElement)) throw new Error('no composer');
  return element;
};

const threadText = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-slot="chat"] ol > li')].map((item) => item.textContent ?? '');

const listed = (container: HTMLElement) => () => {
  if (groups(container).length === 0) throw new Error('history not loaded');
};

const showing = (container: HTMLElement, text: string) => () => {
  if (!threadText(container).some((item) => item.includes(text))) throw new Error(`thread does not show ${text}`);
};

describe('ChatHistory', () => {
  test('the current agent’s conversations by local day', async () => {
    const web = historyWeb(fakeTurnStream());
    const container = mountChat(web);
    await settle(listed(container));
    await settle(showing(container, 'When does Q3 launch?'));
    assert({
      given: 'the Imago agent’s conversations, two either side of local midnight, read at 08:30 in Los Angeles',
      should: 'file them under Today, Yesterday and the date, newest first, from the agent’s own list, marking the chat the pane shows',
      actual: [
        groups(container),
        web.count(CONVERSATIONS) >= 1,
        web.requests.filter((request) => request.url.startsWith('/api/ai/global')),
        current(container),
      ],
      expected: [
        [
          ['Today', ['Q3 launch', 'Early bird']],
          ['Yesterday', ['Roadmap review']],
          ['Sep 18', ['Hiring plan']],
        ],
        true,
        [],
        ['Q3 launch'],
      ],
    });
  });

  test('selecting a thread swaps the messages in place', async () => {
    const web = historyWeb(fakeTurnStream());
    const container = mountChat(web);
    await settle(showing(container, 'When does Q3 launch?'));
    const field = composer(container);
    const pane = container.querySelector('[data-slot="chat"] section');
    const list = history(container);
    act(() => dispatch(transactions.setChatDraft, 'half a thought'));
    field.focus();

    click(row(container, 'Roadmap review'));
    await settle(showing(container, 'Review the roadmap'));

    assert({
      given: 'a past chat picked from the history with a draft typed',
      should: 'show that chat’s messages in the same pane, composer and history, with the draft kept and the row marked',
      actual: [
        threadText(container).some((item) => item.includes('When does Q3 launch?')),
        composer(container) === field,
        container.querySelector('[data-slot="chat"] section') === pane,
        history(container) === list,
        field.value,
        getUiState().resources.chatConversationId,
        current(container),
      ],
      expected: [false, true, true, true, 'half a thought', 'c1', ['Roadmap review']],
    });
  });

  test('a switch while the composer has focus keeps it there', async () => {
    const web = historyWeb(fakeTurnStream());
    const container = mountChat(web);
    await settle(showing(container, 'When does Q3 launch?'));
    const field = composer(container);
    field.focus();

    act(() => dispatch(transactions.openConversation, 'c1'));
    await settle(showing(container, 'Review the roadmap'));
    act(() => dispatch(transactions.startNewChat, undefined));

    assert({
      given: 'the composer focused while the thread changes, then a new chat opens',
      should: 'keep focus in the same composer node (nothing remounts)',
      actual: [document.activeElement === field, composer(container) === field],
      expected: [true, true],
    });
  });

  test('New chat opens an empty thread without remounting the pane', async () => {
    const stream = fakeTurnStream();
    const web = historyWeb(stream, {
      [NEW_CONVERSATION]: () => Response.json({ conversationId: 'c-new', title: 'New conversation', createdAt: '2026-10-05T15:31:00.000Z' }),
      [MESSAGES('c-new')]: () => Response.json(messagesPage([userMessage('n-u', 'Plan the offsite')], { conversationId: 'c-new' })),
    });
    const container = mountChat(web);
    await settle(showing(container, 'When does Q3 launch?'));
    const field = composer(container);
    const pane = container.querySelector('[data-slot="chat"] section');
    act(() => dispatch(transactions.setChatDraft, 'Plan the offsite'));

    click(control(container, 'New chat'));
    await settle(showing(container, 'Ask Imago anything'));
    const fresh = {
      writes: web.writes().length,
      marked: current(container),
      sameComposer: composer(container) === field,
      samePane: container.querySelector('[data-slot="chat"] section') === pane,
      draft: field.value,
    };

    // The first send creates the conversation; the history picks it up when the turn ends.
    web.routes[CONVERSATIONS] = () =>
      Response.json(conversationsPage([agentConversation('c-new', { title: 'Plan the offsite', updatedAt: '2026-10-05T15:31:00.000Z' }), ...LISTED]));
    act(() => {
      field.form?.requestSubmit();
    });
    await settle(() => {
      if (web.count(TURN) !== 1) throw new Error('no turn yet');
    });
    stream.push({ type: 'start', messageId: 'a1' });
    stream.close();
    await settle(() => {
      if (!current(container).includes('Plan the offsite')) throw new Error('new chat not listed');
    });

    assert({
      given: 'New chat with a draft typed, then the draft sent',
      should: 'empty the thread in the same pane and composer, keep the draft, create nothing until the send, then list and mark the new chat',
      actual: [
        fresh,
        web.writes().map((request) => `${request.method} ${request.url}`),
        getUiState().resources.chatConversationId,
        groups(container)[0],
      ],
      expected: [
        { writes: 0, marked: [], sameComposer: true, samePane: true, draft: 'Plan the offsite' },
        [NEW_CONVERSATION, TURN],
        'c-new',
        ['Today', ['Plan the offsite', 'Q3 launch', 'Early bird']],
      ],
    });
  });

  test('switching threads mid-stream', async () => {
    const stream = fakeTurnStream();
    const web = historyWeb(stream);
    const container = mountChat(web);
    await settle(showing(container, 'When does Q3 launch?'));
    act(() => dispatch(transactions.setChatDraft, 'And Q4?'));
    act(() => {
      composer(container).form?.requestSubmit();
    });
    stream.push({ type: 'start', messageId: 'live-1' });
    stream.push({ type: 'text-start', id: 't1' });
    stream.push({ type: 'text-delta', id: 't1', delta: 'Q4 follows in' });
    await settle(showing(container, 'Q4 follows in'));

    click(row(container, 'Roadmap review'));
    await settle(showing(container, 'Review the roadmap'));
    stream.push({ type: 'text-delta', id: 't1', delta: ' January.' });
    await act(async () => {});
    const away = threadText(container);

    click(row(container, 'Q3 launch'));
    await settle(showing(container, 'Q4 follows in January.'));
    const back = threadText(container);
    stream.close();

    assert({
      given: 'a reply streaming into one chat while the viewer opens another and comes back',
      should: 'show none of the live reply or its prompt in the other chat, and the whole reply on return',
      actual: [
        away.some((item) => item.includes('Q4') || item.includes('And Q4?')),
        back.some((item) => item.includes('And Q4?')),
        back.some((item) => item.includes('Q4 follows in January.')),
      ],
      expected: [false, true, true],
    });
  });

  test('a list that failed to load', async () => {
    let fail = true;
    const web = historyWeb(fakeTurnStream(), {
      [CONVERSATIONS]: () => (fail ? Response.json({ error: 'nope' }, { status: 500 }) : Response.json(conversationsPage([...LISTED]))),
    });
    const container = mountChat(web);
    await settle(() => {
      if (!history(container).textContent?.includes('Could not load chats.')) throw new Error('no failure note');
    });
    fail = false;
    const retry = [...history(container).querySelectorAll('button')].find((button) => button.textContent === 'Try again');
    if (retry === undefined) throw new Error('no retry');
    click(retry);
    await settle(listed(container));
    assert({
      given: 'the conversations route failing, then Try again',
      should: 'say it could not load, then list the chats',
      actual: groups(container).map(([label]) => label),
      expected: ['Today', 'Yesterday', 'Sep 18'],
    });
  });

  test('older chats', async () => {
    const web = historyWeb(fakeTurnStream(), {
      [CONVERSATIONS]: () => Response.json(conversationsPage([...LISTED], { totalCount: 51 })),
      [OLDER_CONVERSATIONS]: () =>
        Response.json(conversationsPage([agentConversation('c-old', { title: 'Old idea', updatedAt: '2025-12-31T20:00:00.000Z' })], { page: 1, totalCount: 51 })),
    });
    const container = mountChat(web);
    await settle(listed(container));
    const more = [...history(container).querySelectorAll('button')].find((button) => button.textContent === 'Show older chats');
    if (more === undefined) throw new Error('no older chats control');
    click(more);
    await settle(() => {
      if (groups(container).length !== 4) throw new Error('older page not listed');
    });
    assert({
      given: 'a second page of chats',
      should: 'load it on request, under its own dated group',
      actual: [groups(container).at(-1), history(container).textContent?.includes('Show older chats')],
      expected: [['Dec 31, 2025', ['Old idea']], false],
    });
  });

  test('an Imago agent not provisioned yet', async () => {
    const web = historyWeb(fakeTurnStream(), { [AGENTS]: () => Response.json(pointers({ imago: null })) });
    const container = mountChat(web);
    await settle(() => {
      if (!history(container).textContent?.includes('No chats yet.')) throw new Error('no empty note');
    });
    assert({
      given: 'a viewer whose Imago agent has no page yet',
      should: 'list no chats and ask for none',
      actual: web.count(CONVERSATIONS),
      expected: 0,
    });
  });

  test('the agent chosen in the header', async () => {
    const web = historyWeb(fakeTurnStream(), {
      [SUPPORT_CONVERSATIONS]: () =>
        Response.json(conversationsPage([agentConversation('s1', { title: 'Refund policy', updatedAt: '2026-10-05T14:00:00.000Z' })])),
      [`GET ${chatPaths.messages('a-support', 's1')}`]: () => Response.json(messagesPage([userMessage('s1-u', 'What is the refund policy?')], { conversationId: 's1' })),
    });
    const container = mountChat(web);
    await settle(listed(container));
    act(() => dispatch(transactions.startNewChat, undefined));
    act(() => dispatch(transactions.selectAgent, { id: 'a-support', title: 'Support' }));
    await settle(() => {
      if (!current(container).includes('Refund policy')) throw new Error('support history not shown');
    });
    await settle(showing(container, 'What is the refund policy?'));
    assert({
      given: 'New chat open, then another agent chosen in the chat header',
      should: 'list that agent’s chats beside the pane and leave the new chat for its latest',
      actual: [groups(container), getUiState().resources.chatNew],
      expected: [[['Today', ['Refund policy']]], false],
    });
  });

  test('hide', async () => {
    const container = mountChat(historyWeb(fakeTurnStream()));
    click(control(container, 'Hide Chat history'));
    assert({
      given: '× on the history',
      should: 'hide the chat’s list as view state',
      actual: getUiState().resources.collapsedSections,
      expected: ['chat'],
    });
  });
});
