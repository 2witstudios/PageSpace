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
import { stageFor } from '@/ui/frame/stage/stage';
import { taskPaths } from '@/ui/tasks/task-api/task-api';
import { chatPaths } from '../chat-api/chat-api';
import {
  agentConversation,
  assistantWithTool,
  conversationsPage,
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
        container.querySelector('header')?.textContent,
        user?.dataset.role,
        reply?.querySelector('details summary')?.textContent?.includes('Read page'),
        chip?.getAttribute('href'),
        web.requests.filter((request) => request.url.startsWith('/api/ai/global')),
      ],
      expected: ['roomy', 'Imago/Alpha in context', 'user', true, '/d1/files/p1', []],
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
});
