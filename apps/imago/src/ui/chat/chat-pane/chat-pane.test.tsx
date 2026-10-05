// @vitest-environment jsdom
import { act, useState } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { fakeWeb, type FakeRoute } from '@/ui/test-support/fake-web';
import { fakeTurnStream, type FakeTurnStream } from '@/ui/test-support/fake-turn-stream';
import { click, mount, press, unmountAll } from '@/ui/test-support/dom';
import { getUiState, setUiState } from '@/ui/store/store';
import { createInitialState } from '@/ui/store/state';
import { dispatch, transactions } from '@/ui/store/transactions';
import { stageFor } from '@/ui/frame/stage/stage';
import { taskPaths } from '@/ui/tasks/task-api/task-api';
import { chatPaths } from '../chat-api/chat-api';
import {
  agentConversation,
  assistantWithTool,
  conversationsPage,
  driveAgentsBody,
  messagesPage,
  pointers,
  userMessage,
} from '../chat-model/fixtures';
import type { ChatMessage } from '../chat-model/chat';
import { ChatPane } from './chat-pane';

const AGENTS = `GET ${chatPaths.builtinAgents}`;
const CONVERSATIONS = `GET ${chatPaths.conversations('p-imago', 0)}`;
const NEW_CONVERSATION = `POST ${chatPaths.newConversation('p-imago')}`;
const MESSAGES = `GET ${chatPaths.messages('p-imago', 'c1')}`;
const NEW_MESSAGES = `GET ${chatPaths.messages('p-imago', 'c-new')}`;
const TURN = `POST ${chatPaths.turn}`;
const ABORT = `POST ${chatPaths.abort}`;
const TRAIL = `GET ${taskPaths.breadcrumbs('p1')}`;
const DRIVE_AGENTS = `GET ${chatPaths.driveAgents('d1')}`;
const SUPPORT_CONVERSATIONS = `GET ${chatPaths.conversations('a1', 0)}`;
const SUPPORT_MESSAGES = `GET ${chatPaths.messages('a1', 'k1')}`;
const NOTES_CONVERSATIONS = `GET ${chatPaths.conversations('a2', 0)}`;
const PLANNER_CONVERSATIONS = `GET ${chatPaths.conversations('p-planner', 0)}`;
const PLANNER_MESSAGES = `GET ${chatPaths.messages('p-planner', 'pc1')}`;

const HISTORY: ChatMessage[] = [
  userMessage('m1', 'What does the roadmap say?'),
  {
    ...assistantWithTool('m2'),
    parts: [...assistantWithTool('m2').parts, { type: 'text', text: ' See @[Roadmap](p1:page).' }],
  },
];

beforeEach(() => {
  setUiState(createInitialState());
});

afterEach(() => {
  unmountAll();
});

// SWR and the stream resolve outside React's event loop: flush them per poll.
const settle = (check: () => void, timeout = 1000): Promise<void> =>
  vi.waitFor(
    async () => {
      await act(async () => {});
      check();
    },
    { timeout, interval: 5 },
  );

const chatWeb = (stream: FakeTurnStream, extra: Record<string, FakeRoute> = {}) =>
  fakeWeb({
    [AGENTS]: () => Response.json(pointers()),
    [CONVERSATIONS]: () => Response.json(conversationsPage([agentConversation('c1'), agentConversation('c0')])),
    [MESSAGES]: () => Response.json(messagesPage(HISTORY)),
    [TURN]: () => stream.response(),
    [ABORT]: () => Response.json({ aborted: true }),
    [DRIVE_AGENTS]: () =>
      Response.json(
        driveAgentsBody([
          { id: 'a1', title: 'Support' },
          { id: 'a2', title: 'Release notes' },
        ]),
      ),
    [SUPPORT_CONVERSATIONS]: () => Response.json(conversationsPage([agentConversation('k1'), agentConversation('k0')])),
    [SUPPORT_MESSAGES]: () =>
      Response.json(messagesPage([userMessage('s1', 'Any open tickets?'), userMessage('s2', 'And the backlog?')], { conversationId: 'k1' })),
    [PLANNER_CONVERSATIONS]: () => Response.json(conversationsPage([agentConversation('pc1')])),
    [PLANNER_MESSAGES]: () =>
      Response.json(messagesPage([userMessage('q1', 'Plan my week'), userMessage('q2', 'And next week')], { conversationId: 'pc1' })),
    [TRAIL]: () =>
      Response.json([
        { id: 'f1', title: 'Plans', type: 'FOLDER', parentId: null },
        { id: 'p1', title: 'Roadmap', type: 'DOCUMENT', parentId: 'f1' },
      ]),
    ...extra,
  });

type Web = ReturnType<typeof chatWeb>;

/** The pane as the shell holds it: the test moves the URL, the pane stays mounted unless `shown` drops it. */
const Host = ({ path, control }: { path: string; control: { go?: (path: string) => void; show?: (shown: boolean) => void } }) => {
  const [pathname, setPathname] = useState(path);
  const [shown, setShown] = useState(true);
  control.go = setPathname;
  control.show = setShown;
  return shown ? <ChatPane stage={stageFor(pathname)} driveName="Alpha" homeDriveId="home-1" /> : null;
};

const mountPane = (web: Web, path = '/d1') => {
  const control: { go?: (path: string) => void; show?: (shown: boolean) => void } = {};
  const container = mount(
    <ImagoSWRProvider client={web.client}>
      <Host path={path} control={control} />
    </ImagoSWRProvider>,
  );
  return { container, control };
};

const field = (container: HTMLElement): HTMLTextAreaElement => {
  const element = container.querySelector('textarea');
  if (!(element instanceof HTMLTextAreaElement)) throw new Error('no composer');
  return element;
};

const control = (container: HTMLElement): HTMLButtonElement => {
  const element = container.querySelector('form button');
  if (!(element instanceof HTMLButtonElement)) throw new Error('no send control');
  return element;
};

const type = (container: HTMLElement, text: string): void => {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setValue?.call(field(container), text);
    field(container).dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const picker = (container: HTMLElement): HTMLSelectElement => {
  const element = container.querySelector('header select');
  if (!(element instanceof HTMLSelectElement)) throw new Error('no agent picker');
  return element;
};

/** Picks an agent in the header the way a viewer does: the select's value, then its change event. */
const choose = (container: HTMLElement, value: string): void => {
  act(() => {
    picker(container).value = value;
    picker(container).dispatchEvent(new Event('change', { bubbles: true }));
  });
};

const pickerOffers = (container: HTMLElement) =>
  [...picker(container).querySelectorAll('optgroup')].map((group) => [
    group.label,
    [...group.querySelectorAll('option')].map((option) => `${option.value}:${option.textContent}${option.disabled ? ':disabled' : ''}`),
  ]);

const drivesListed = (container: HTMLElement) => () => {
  if (picker(container).querySelectorAll('optgroup').length !== 2) throw new Error('drive agents not listed');
};

const turnBody = (web: Web) =>
  web.requests.filter((request) => `${request.method} ${request.url}` === TURN).at(-1)?.body as {
    chatId: string;
    conversationId: string;
    contextRef: unknown;
  };

const items = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('ol > li[data-role]')];

const threadLoaded = (container: HTMLElement, count = 2) => () => {
  if (items(container).length !== count) throw new Error(`thread has ${items(container).length} messages`);
};

describe('ChatPane', () => {
  test('the latest conversation with Imago', async () => {
    const web = chatWeb(fakeTurnStream());
    const { container } = mountPane(web);
    await settle(threadLoaded(container));
    const [user, reply] = items(container);
    const chip = reply?.querySelector('a[data-citation]');
    assert({
      given: 'the drive chat for a viewer whose Imago agent has conversations',
      should: 'open the most recent one: the user card, the reply as prose with its tool line and a page chip, under a roomy header naming Imago and the drive',
      actual: [
        container.querySelector('section')?.dataset.density,
        [picker(container).value, picker(container).getAttribute('aria-label'), container.querySelector('header small')?.textContent],
        user?.dataset.role,
        reply?.querySelector('details summary')?.textContent?.includes('Read page'),
        chip?.getAttribute('href'),
        web.requests.filter((request) => request.url.startsWith('/api/ai/global')),
      ],
      expected: ['roomy', ['p-imago', 'Agent', 'Alpha in context'], 'user', true, '/d1/files/p1', []],
    });
  });

  test('dense beside an open page, named in the header', async () => {
    const web = chatWeb(fakeTurnStream());
    const { container } = mountPane(web, '/d1/files/p1');
    await settle(() => {
      if (container.querySelector('header small')?.textContent !== 'Roadmap in context') throw new Error('object not named');
    });
    assert({
      given: 'a page open in the object pane',
      should: 'switch to the dense chat and name the page from its trail',
      actual: [container.querySelector('section')?.dataset.density, field(container).placeholder],
      expected: ['dense', 'Ask about Roadmap…'],
    });
  });

  test('Enter sends, Stop stops', async () => {
    const stream = fakeTurnStream();
    const web = chatWeb(stream);
    const { container } = mountPane(web, '/d1/files/p1');
    await settle(threadLoaded(container));

    type(container, 'Summarise it');
    press(field(container), 'Enter');
    await settle(() => {
      if (web.count(TURN) !== 1) throw new Error('not sent');
    });
    const body = web.requests.find((request) => `${request.method} ${request.url}` === TURN)?.body as {
      chatId: string;
      conversationId: string;
      contextRef: unknown;
      messages: ChatMessage[];
    };
    const afterSend = [getUiState().resources.chatDraft, field(container).value];

    stream.push({ type: 'start', messageId: 'a1' });
    stream.push({ type: 'text-start', id: 't1' });
    stream.push({ type: 'text-delta', id: 't1', delta: 'It ships **in October**' });
    await settle(() => {
      if (items(container).at(-1)?.querySelector('strong')?.textContent !== 'in October') throw new Error('no reply');
    });
    const streaming = [control(container).getAttribute('aria-label'), items(container).at(-1)?.getAttribute('aria-busy')];

    click(control(container));
    await settle(() => {
      if (web.count(ABORT) !== 1) throw new Error('not stopped');
    });
    await settle(() => {
      if (control(container).getAttribute('aria-label') !== 'Send') throw new Error('still streaming');
    });

    assert({
      given: 'a prompt typed beside the Roadmap and sent with Enter, then stopped mid-reply',
      should: 'send it in parts to the latest conversation with the page as context, clear the draft, stream the reply as prose with Stop in place of Send, and abort through /api/ai/abort',
      actual: [
        [body.chatId, body.conversationId, body.contextRef, body.messages[0]?.parts],
        afterSend,
        streaming,
        web.writes().map((request) => `${request.method} ${request.url}`),
        items(container).at(-1)?.textContent?.includes('It ships in October'),
      ],
      expected: [
        ['p-imago', 'c1', { routeType: 'page', pageId: 'p1', driveId: 'd1' }, [{ type: 'text', text: 'Summarise it' }]],
        ['', ''],
        ['Stop', 'true'],
        [TURN, ABORT],
        true,
      ],
    });
  });

  test('the hidden history’s opener', async () => {
    const web = chatWeb(fakeTurnStream());
    const { container, control: host } = mountPane(web);
    await settle(threadLoaded(container));
    const opener = () => container.querySelector<HTMLButtonElement>('header [data-leading] button[aria-label="Show Chat history"]');
    const shown = opener() !== null;
    act(() => dispatch(transactions.collapseSection, 'chat'));
    act(() => host.go?.('/d1/files/p1'));
    const besideObject = opener() !== null;
    act(() => host.go?.('/d1'));
    const hidden = opener();
    if (hidden !== null) click(hidden);

    assert({
      given: 'the history shown, then hidden with a page open, then hidden on the chat stage and the opener pressed',
      should: 'put the hamburger in the chat header only while the chat stage’s history is hidden, and bring it back',
      actual: [shown, besideObject, hidden !== null, getUiState().resources.collapsedSections, opener()],
      expected: [false, false, true, [], null],
    });
  });

  test('the draft survives navigation', async () => {
    const web = chatWeb(fakeTurnStream());
    const { container, control: host } = mountPane(web);
    await settle(threadLoaded(container));
    type(container, 'Half a thought');

    act(() => host.go?.('/d1/tasks'));
    const moved = [container.querySelector('section')?.dataset.density, field(container).value];
    act(() => host.show?.(false));
    act(() => host.show?.(true));
    await settle(threadLoaded(container));

    assert({
      given: 'a typed draft, then a move to tasks, then the pane unmounted and mounted again',
      should: 'keep the draft in shell state the whole way, sending nothing',
      actual: [moved, getUiState().resources.chatDraft, field(container).value, web.count(TURN)],
      expected: [['roomy', 'Half a thought'], 'Half a thought', 'Half a thought', 0],
    });
  });

  test('a first conversation', async () => {
    const stream = fakeTurnStream();
    const web = chatWeb(stream, {
      [CONVERSATIONS]: () => Response.json(conversationsPage([])),
      [NEW_CONVERSATION]: () => Response.json({ conversationId: 'c-new', title: 'New conversation', createdAt: '2026-10-05T10:00:00.000Z' }),
      [NEW_MESSAGES]: () => Response.json(messagesPage([], { conversationId: 'c-new' })),
    });
    const { container } = mountPane(web);
    await settle(() => {
      if (container.querySelector('ol > li')?.textContent?.startsWith('Ask Imago') !== true) throw new Error('not empty');
    });

    type(container, 'Hello');
    press(field(container), 'Enter');
    stream.push({ type: 'start', messageId: 'a1' });
    stream.push({ type: 'text-start', id: 't1' });
    stream.push({ type: 'text-delta', id: 't1', delta: 'Hi there.' });
    await settle(threadLoaded(container));
    const body = web.requests.find((request) => `${request.method} ${request.url}` === TURN)?.body as { conversationId: string };

    assert({
      given: 'a viewer with no conversations who sends a first prompt',
      should: 'create a conversation, open it in shell state, and stream the turn into it',
      actual: [
        web.writes().map((request) => `${request.method} ${request.url}`),
        body.conversationId,
        getUiState().resources.chatConversationId,
        items(container).map((item) => item.textContent?.replace(/^.* said: /, '')),
      ],
      expected: [[NEW_CONVERSATION, TURN], 'c-new', 'c-new', ['Hello', 'Hi there.']],
    });
    stream.close();
  });

  test('a send before the conversations load', async () => {
    const stream = fakeTurnStream();
    let release: () => void = () => {};
    const listed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const web = chatWeb(stream, {
      [CONVERSATIONS]: async () => {
        await listed;
        return Response.json(conversationsPage([agentConversation('c1')]));
      },
      [NEW_CONVERSATION]: () => Response.json({ conversationId: 'c-new' }),
    });
    const { container } = mountPane(web);
    await settle(() => {
      if (web.count(CONVERSATIONS) !== 1) throw new Error('list not asked for');
    });
    type(container, 'Continue');
    press(field(container), 'Enter');
    await act(async () => {});
    const waiting = [control(container).disabled, web.writes().length, getUiState().resources.chatDraft];

    release();
    await settle(threadLoaded(container));
    press(field(container), 'Enter');
    await settle(() => {
      if (web.count(TURN) !== 1) throw new Error('not sent');
    });
    const body = web.requests.find((request) => `${request.method} ${request.url}` === TURN)?.body as { conversationId: string };

    assert({
      given: 'a prompt sent while the agent’s conversations are still loading, then again once they have',
      should: 'hold Send and the draft until the list says which conversation is latest, then continue it rather than start a new one',
      actual: [waiting, body.conversationId, web.count(NEW_CONVERSATION)],
      expected: [[true, 0, 'Continue'], 'c1', 0],
    });
    stream.close();
  });

  test('an Imago agent not provisioned yet', async () => {
    const web = chatWeb(fakeTurnStream(), { [AGENTS]: () => Response.json(pointers({ imago: null })) });
    const { container } = mountPane(web);
    await settle(() => {
      if (container.querySelector('[role="alert"]') === null) throw new Error('no notice');
    });
    type(container, 'Hello');
    press(field(container), 'Enter');
    assert({
      given: 'a viewer whose Imago agent has no page yet',
      should: 'say so, disable sending and load no conversation',
      actual: [
        container.querySelector('[role="alert"]')?.textContent,
        control(container).disabled,
        web.count(CONVERSATIONS),
        web.count(TURN),
      ],
      expected: ['Imago is still being set up. Try again in a moment.', true, 0, 0],
    });
  });

  test('a refused turn', async () => {
    const web = chatWeb(fakeTurnStream(), {
      [TURN]: () => Response.json({ error: 'Rate limited' }, { status: 429 }),
    });
    const { container } = mountPane(web);
    await settle(threadLoaded(container));
    type(container, 'Hello');
    press(field(container), 'Enter');
    await settle(() => {
      if (container.querySelector('[role="alert"]') === null) throw new Error('no notice');
    });
    assert({
      given: 'a turn the server refuses',
      should: 'say the reply failed and give the prompt back as the draft',
      actual: [container.querySelector('[role="alert"]')?.textContent, field(container).value],
      expected: ['The reply failed. Try again.', 'Hello'],
    });
  });

  test('the agent selector', async () => {
    const web = chatWeb(fakeTurnStream());
    const { container } = mountPane(web);
    await settle(threadLoaded(container));
    await settle(drivesListed(container));
    assert({
      given: 'the chat header in a drive with two agents the server says the viewer can use',
      should: 'offer the three Imago agents first, then the drive’s agents under its name, with Imago chosen',
      actual: [pickerOffers(container), picker(container).value, web.count(DRIVE_AGENTS)],
      expected: [
        [
          ['Imago', ['p-imago:Imago', 'p-planner:Planner', 'p-researcher:Researcher']],
          ['Alpha', ['a1:Support', 'a2:Release notes']],
        ],
        'p-imago',
        1,
      ],
    });
  });

  test('switching agent', async () => {
    const stream = fakeTurnStream();
    const web = chatWeb(stream);
    const { container } = mountPane(web);
    await settle(threadLoaded(container));
    await settle(drivesListed(container));
    type(container, 'Half a thought');

    choose(container, 'a1');
    await settle(() => {
      if (items(container)[0]?.textContent?.includes('Any open tickets?') !== true) throw new Error('support thread not open');
    });
    const atSupport = [
      picker(container).value,
      getUiState().resources.chatAgent,
      field(container).value,
      field(container).getAttribute('aria-label'),
    ];

    choose(container, 'p-planner');
    await settle(() => {
      if (items(container)[0]?.textContent?.includes('Plan my week') !== true) throw new Error('planner thread not open');
    });
    press(field(container), 'Enter');
    await settle(() => {
      if (web.count(TURN) !== 1) throw new Error('not sent');
    });

    choose(container, 'p-imago');
    await settle(() => {
      if (items(container)[0]?.textContent?.includes('What does the roadmap say?') !== true) throw new Error('imago thread not open');
    });

    assert({
      given: 'a draft typed with Imago, then Support chosen, then the planner chosen and the draft sent, then Imago again',
      should: 'open each agent’s latest conversation in the same pane with the draft kept, send to the chosen agent, and return to Imago’s latest',
      actual: [
        atSupport,
        [turnBody(web).chatId, turnBody(web).conversationId],
        [getUiState().resources.chatAgent, picker(container).value],
        web.writes().map((request) => `${request.method} ${request.url}`),
      ],
      expected: [
        ['a1', { id: 'a1', title: 'Support' }, 'Half a thought', 'Message Support'],
        ['p-planner', 'pc1'],
        [null, 'p-imago'],
        [TURN],
      ],
    });
    stream.close();
  });

  test('opening an object changes only the context', async () => {
    const stream = fakeTurnStream();
    const web = chatWeb(stream);
    const { container, control: host } = mountPane(web);
    await settle(threadLoaded(container));
    await settle(drivesListed(container));
    choose(container, 'a1');
    await settle(() => {
      if (items(container)[0]?.textContent?.includes('Any open tickets?') !== true) throw new Error('support thread not open');
    });
    const lists = web.count(SUPPORT_CONVERSATIONS);

    act(() => host.go?.('/d1/files/p1'));
    await settle(() => {
      if (container.querySelector('header small')?.textContent !== 'Roadmap in context') throw new Error('object not named');
    });
    type(container, 'Summarise it');
    press(field(container), 'Enter');
    await settle(() => {
      if (web.count(TURN) !== 1) throw new Error('not sent');
    });

    assert({
      given: 'Support chosen in its latest conversation, then a page opened in the object pane and a prompt sent',
      should: 'keep the agent and the conversation, and change only the context the turn carries',
      actual: [
        [picker(container).value, getUiState().resources.chatAgent?.id],
        [turnBody(web).chatId, turnBody(web).conversationId, turnBody(web).contextRef],
        web.count(SUPPORT_CONVERSATIONS) === lists,
        items(container)[0]?.textContent?.includes('Any open tickets?'),
      ],
      expected: [
        ['a1', 'a1'],
        ['a1', 'k1', { routeType: 'page', pageId: 'p1', driveId: 'd1' }],
        true,
        true,
      ],
    });
    stream.close();
  });

  test('an agent the viewer lost access to', async () => {
    const web = chatWeb(fakeTurnStream(), {
      [SUPPORT_CONVERSATIONS]: () => Response.json({ error: 'Insufficient permissions to view this agent' }, { status: 403 }),
      [NOTES_CONVERSATIONS]: () => Response.json({ error: 'AI agent not found' }, { status: 404 }),
    });
    const { container } = mountPane(web);
    await settle(threadLoaded(container));
    await settle(drivesListed(container));

    choose(container, 'a1');
    await settle(() => {
      if (container.querySelector('[role="alert"]') === null) throw new Error('no notice');
    });
    await settle(threadLoaded(container));
    type(container, 'Still there?');
    const refused = [
      container.querySelector('[role="alert"]')?.textContent,
      picker(container).value,
      getUiState().resources.chatAgent,
      items(container)[0]?.textContent?.includes('What does the roadmap say?'),
      control(container).disabled,
    ];

    choose(container, 'a2');
    await settle(() => {
      if (container.querySelector('[role="alert"]')?.textContent?.includes('Release notes') !== true) throw new Error('no notice');
    });
    const gone = [container.querySelector('[role="alert"]')?.textContent, picker(container).value];

    choose(container, 'p-planner');
    await settle(() => {
      if (items(container)[0]?.textContent?.includes('Plan my week') !== true) throw new Error('planner thread not open');
    });

    assert({
      given: 'an agent the server now refuses (403), then one it no longer has (404), then the planner chosen',
      should: 'fall back to Imago with its latest conversation and a notice naming the lost agent each time, and clear the notice on the next choice',
      actual: [refused, gone, container.querySelector('[role="alert"]')],
      expected: [
        ['You no longer have access to Support, so Imago is answering.', 'p-imago', null, true, false],
        ['You no longer have access to Release notes, so Imago is answering.', 'p-imago'],
        null,
      ],
    });
  });

  test('a conversation list that failed', async () => {
    const stream = fakeTurnStream();
    const web = chatWeb(stream, {
      [CONVERSATIONS]: () => Response.json({ error: 'Failed to fetch conversations' }, { status: 500 }),
      [NEW_CONVERSATION]: () => Response.json({ conversationId: 'c-new' }),
      [NEW_MESSAGES]: () => Response.json(messagesPage([], { conversationId: 'c-new' })),
    });
    const { container } = mountPane(web);
    await settle(() => {
      if (container.querySelector('[role="alert"]') === null) throw new Error('no notice');
    });
    type(container, 'Hello');
    const failed = [container.querySelector('[role="alert"]')?.textContent, control(container).disabled];
    press(field(container), 'Enter');
    stream.push({ type: 'start', messageId: 'a1' });
    stream.push({ type: 'text-start', id: 't1' });
    stream.push({ type: 'text-delta', id: 't1', delta: 'Hi there.' });
    await settle(() => {
      if (items(container).at(-1)?.textContent?.includes('Hi there.') !== true) throw new Error('no reply');
    });

    assert({
      given: 'Imago’s conversation list failing to load, then a prompt sent',
      should: 'say the chat could not load but keep Send enabled, then start a new conversation and stream the turn into it',
      actual: [
        failed,
        web.writes().map((request) => `${request.method} ${request.url}`),
        turnBody(web).conversationId,
        getUiState().resources.chatConversationId,
      ],
      expected: [['This chat could not load. Try again in a moment.', false], [NEW_CONVERSATION, TURN], 'c-new', 'c-new'],
    });
    stream.close();
  });
});
