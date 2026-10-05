// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { RealtimeProvider } from '@/realtime/realtime-provider';
import { mount, press, typeInto, click, unmountAll } from '@/ui/test-support/dom';
import { fakeRealtime } from '@/ui/test-support/fake-realtime';
import { fakeWeb, type FakeRoute } from '@/ui/test-support/fake-web';
import { conversation, dmMessage } from '../message-model/fixtures';
import type { DmMessageResponse } from '../message-model/dm-message';
import { messagePaths } from '../messages-api/messages-api';
import { dmPaths } from '../dm-thread/dm-api';
import { DmThread } from './dm-thread';

afterEach(() => {
  unmountAll();
});

/** Polls `check` in short act() ticks, so reducer updates render between polls. */
const settle = async (check: () => void, timeout = 1000): Promise<void> => {
  const until = Date.now() + timeout;
  for (;;) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() > until) throw error;
    }
  }
};

const idle = (ms: number): Promise<void> => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const CONVERSATIONS = `GET ${messagePaths.conversations()}`;
const MESSAGES = `GET ${dmPaths.messages('dm1')}`;
const SEND = `POST ${dmPaths.conversation('dm1')}`;
const READ = `PATCH ${dmPaths.conversation('dm1')}`;

const ada = { id: 'u1', name: 'Ada Lovelace', image: null };

/** A message as the POST answers and realtime broadcasts it: the bare row, no sender joined. */
const bare = (id: string, overrides: Partial<DmMessageResponse> = {}): DmMessageResponse => {
  const { sender: _sender, reactions: _reactions, ...row } = dmMessage(id, overrides);
  return row;
};

const routes = (): Record<string, FakeRoute> => ({
  [CONVERSATIONS]: () =>
    Response.json({ conversations: [conversation('dm1')], pagination: { hasMore: false, nextCursor: null } }),
  [MESSAGES]: () =>
    Response.json({
      messages: [
        dmMessage('m1', { createdAt: '2026-10-04T16:00:00.000Z' }),
        dmMessage('m2', { createdAt: '2026-10-05T09:00:00.000Z', senderId: 'u1', sender: ada, content: 'morning' }),
        dmMessage('m3', { createdAt: '2026-10-05T09:01:00.000Z', content: 'hi @[Ada Lovelace](u1:user)' }),
      ],
      notificationsMarkedRead: 1,
    }),
  [READ]: () => Response.json({ success: true, notificationsMarkedRead: 1 }),
});

const show = (extra: Record<string, FakeRoute> = {}) => {
  const web = fakeWeb({ ...routes(), ...extra });
  const rt = fakeRealtime();
  const container = mount(
    <ImagoSWRProvider client={web.client}>
      <RealtimeProvider client={rt.client}>
        <DmThread conversationId="dm1" viewerId="u1" now={() => new Date('2026-10-05T12:00:00.000Z')} markReadDelayMs={20} />
      </RealtimeProvider>
    </ImagoSWRProvider>,
  );
  const field = () => container.querySelector('textarea') as HTMLTextAreaElement;
  return { web, rt, container, field };
};

const loaded = (container: HTMLElement) =>
  settle(() => {
    if (container.querySelectorAll('ol > li').length === 0) throw new Error('messages not loaded');
    if (container.querySelector('h1 > span:last-child')?.textContent !== 'Grace') throw new Error('name not loaded');
  });

/** Each row: a divider's label, or `lead|follow:<author>:<text>`, with `(sending)` on one not yet stored. */
const rows = (container: HTMLElement) =>
  [...container.querySelectorAll('ol > li')].map((row) =>
    row.getAttribute('role') === 'separator'
      ? `—${row.getAttribute('aria-label')}—`
      : `${row.querySelector('b') ? 'lead' : 'follow'}:${row.querySelector('b')?.textContent ?? row.querySelector('.sr-only')?.textContent}:${row.querySelector('p:last-of-type')?.textContent}${row.hasAttribute('data-pending') ? ' (sending)' : ''}`,
  );

/** The rows after the loaded page's five. */
const tail = (container: HTMLElement) => rows(container).slice(5);

const sentNonce = (web: ReturnType<typeof fakeWeb>): unknown =>
  (web.writes().find((request) => request.method === 'POST')?.body as { clientNonce?: unknown } | undefined)?.clientNonce;

const deferred = () => {
  let release: (response: Response) => void = () => {};
  const answer = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { answer, release };
};

describe('DmThread', () => {
  test('reading a DM', async () => {
    const { web, rt, container } = show();
    await loaded(container);
    await idle(40);

    assert({
      given: 'a DM opened at /imago/dm/dm1',
      should:
        'load its messages from /api/messages/dm1 into the shared thread view with nothing New (the GET read them), title it with the other person, offer the composer, join its room, and not mark it read again',
      actual: [
        web.requests.filter((request) => request.method === 'GET').map((request) => request.url).sort(),
        container.querySelector('section')?.getAttribute('aria-label'),
        container.querySelector('h1 img')?.getAttribute('src'),
        rows(container),
        container.querySelector('[data-mention="user"]')?.className.includes('bg-accent-soft'),
        container.querySelector('textarea')?.getAttribute('aria-label'),
        rt.live()[0]?.emitted,
        web.count(READ),
      ],
      expected: [
        ['/api/messages/conversations?limit=100', '/api/messages/dm1?limit=50'].sort(),
        'Grace',
        'https://img/grace.png',
        [
          '—Yesterday—',
          'lead:Grace Hopper:message m1',
          '—Today—',
          'lead:Ada Lovelace:morning',
          'lead:Grace Hopper:hi @Ada Lovelace',
        ],
        true,
        'Message Grace',
        [['join_dm_conversation', 'dm1']],
        0,
      ],
    });
  });

  test('sending: the response first, then the socket echo', async () => {
    const post = deferred();
    const { web, rt, container, field } = show({ [SEND]: () => post.answer });
    await loaded(container);
    typeInto(field(), 'see you at 3');
    press(field(), 'Enter');
    await settle(() => {
      if (web.count(SEND) === 0) throw new Error('not sent');
    });
    const optimistic = tail(container);
    const draftAfterSend = field().value;
    const nonce = sentNonce(web);
    const stored = { ...bare('m9', { senderId: 'u1', content: 'see you at 3', createdAt: '2026-10-05T12:00:01.000Z' }), clientNonce: nonce };

    post.release(Response.json({ message: stored }));
    await settle(() => {
      if (container.querySelector('[data-pending]')) throw new Error('not confirmed');
    });
    const confirmed = tail(container);
    rt.emit('new_dm_message', stored);
    await idle(20);

    assert({
      given: 'a message typed and sent with Enter, the POST answering with the bare row before the broadcast',
      should:
        'POST it to /api/messages/dm1 with the CSRF token and a nonce, show it at once as sending with the draft cleared, swap in the stored copy under the viewer’s name, and not duplicate it on the echo',
      actual: [
        web.writes().filter((request) => request.method === 'POST'),
        typeof nonce === 'string' && nonce.length > 0,
        optimistic,
        draftAfterSend,
        confirmed,
        tail(container),
      ],
      expected: [
        [{ method: 'POST', url: '/api/messages/dm1', csrf: 'tok-1', body: { content: 'see you at 3', clientNonce: nonce } }],
        true,
        ['lead:Ada Lovelace:see you at 3 (sending)'],
        '',
        ['lead:Ada Lovelace:see you at 3'],
        ['lead:Ada Lovelace:see you at 3'],
      ],
    });
  });

  test('sending: the socket echo first, then the response', async () => {
    const post = deferred();
    const { web, rt, container, field } = show({ [SEND]: () => post.answer });
    await loaded(container);
    typeInto(field(), 'echo wins');
    press(field(), 'Enter');
    await settle(() => {
      if (web.count(SEND) === 0) throw new Error('not sent');
    });
    const nonce = sentNonce(web);
    const stored = { ...bare('m9', { senderId: 'u1', content: 'echo wins', createdAt: '2026-10-05T12:00:01.000Z' }), clientNonce: nonce };
    rt.emit('new_dm_message', stored);
    await idle(10);
    const echoed = tail(container);
    post.release(Response.json({ message: stored }));
    await idle(30);

    assert({
      given: 'the broadcast of the viewer’s message landing before its POST resolves',
      should: 'confirm the message on the echo and ignore the late response',
      actual: [echoed, tail(container)],
      expected: [['lead:Ada Lovelace:echo wins'], ['lead:Ada Lovelace:echo wins']],
    });
  });

  test('a failed send', async () => {
    const { container, field } = show({
      [SEND]: () => Response.json({ error: 'You can\'t message this user' }, { status: 403 }),
    });
    await loaded(container);
    typeInto(field(), 'hello?');
    press(field(), 'Enter');
    await settle(() => {
      if (!container.querySelector('[role="alert"]')) throw new Error('no error yet');
    });

    assert({
      given: 'apps/web refusing the message',
      should: 'take the sending message back out, put the text back and say it was not sent',
      actual: [tail(container), field().value, container.querySelector('[role="alert"]')?.textContent],
      expected: [[], 'hello?', 'Could not send your message. You can\'t message this user'],
    });
  });

  test('replies arrive live', async () => {
    const { web, rt, container } = show();
    await loaded(container);
    const socket = rt.live()[0];

    const reply = bare('m10', { content: 'on my way', createdAt: '2026-10-05T12:00:05.000Z' });
    rt.emit('new_dm_message', reply);
    rt.emit('new_dm_message', reply);
    rt.emit('new_dm_message', bare('m11', { conversationId: 'dm2', content: 'another conversation' }));
    rt.emit('new_dm_message', bare('m12', { parentId: 'm3', content: 'in a thread', createdAt: '2026-10-05T12:00:06.000Z' }));
    rt.emit('new_dm_message', { id: 'm13', content: 'not a message' });
    await settle(() => {
      if (web.count(READ) === 0) throw new Error('not marked read');
    });
    const shown = tail(container);
    rt.emit('connect');
    unmountAll();

    assert({
      given: 'the other person’s reply broadcast twice as a bare row, another conversation’s message, a thread reply, a malformed payload, a reconnect and leaving',
      should:
        'show the reply once under their name after a New divider, ignore the rest, mark the DM read with a PATCH, rejoin after the reconnect and leave the room on the way out',
      actual: [shown, web.writes().filter((request) => request.method === 'PATCH').map((request) => [request.url, request.csrf]), socket?.emitted],
      expected: [
        ['—New—', 'lead:Grace Hopper:on my way'],
        [['/api/messages/dm1', 'tok-1']],
        [
          ['join_dm_conversation', 'dm1'],
          ['join_dm_conversation', 'dm1'],
          ['leave_dm_conversation', 'dm1'],
        ],
      ],
    });
  });

  test('a first message from the other person, before any of theirs is loaded', async () => {
    const { rt, container } = show({
      [MESSAGES]: () => Response.json({ messages: [], notificationsMarkedRead: 0 }),
    });
    await settle(() => {
      if (!container.querySelector('textarea')) throw new Error('not loaded');
    });
    await settle(() => {
      if (container.querySelector('h1 > span:last-child')?.textContent !== 'Grace') throw new Error('name not loaded');
    });
    const empty = container.querySelector('section > p')?.textContent;
    rt.emit('new_dm_message', bare('m1', { content: 'hello', createdAt: '2026-10-05T11:00:00.000Z' }));
    await settle(() => {
      if (container.querySelectorAll('ol > li').length === 0) throw new Error('not shown');
    });

    assert({
      given: 'an empty DM, then the other person’s first message arriving without a sender',
      should: 'say there are no messages yet, then name the message from the DM list and mark it New',
      actual: [empty, rows(container)],
      expected: ['No messages with Grace yet.', ['—Today, New—', 'lead:Grace:hello']],
    });
  });

  test('a DM the viewer is not in', async () => {
    // The list still names the conversation (a stale list, or a link opened
    // past the gate), but apps/web refuses it: only the thread can tell.
    const { web, rt, container } = show({
      [MESSAGES]: () => Response.json({ error: 'Conversation not found' }, { status: 404 }),
    });
    await settle(() => {
      if (!container.querySelector('[data-not-found]')) throw new Error('not refused yet');
    });
    rt.emit('new_dm_message', bare('m10', { content: 'leaked?', createdAt: '2026-10-05T12:00:05.000Z' }));
    await idle(80);

    assert({
      given: 'a conversation the DM list names but apps/web answers 404 for, then a broadcast to it, past the read debounce',
      should:
        'draw only not-found: no name, face, messages or composer, nothing broadcast to it, and no write of any kind',
      actual: [
        container.querySelector('[data-not-found] h2')?.textContent,
        container.textContent?.includes('Grace'),
        container.querySelector('img'),
        container.querySelectorAll('ol > li').length,
        container.querySelector('textarea'),
        container.textContent?.includes('leaked?'),
        web.writes(),
      ],
      expected: ['Conversation not found', false, null, 0, null, false, []],
    });
  });

  test('a DM that fails to load', async () => {
    let fail = true;
    const { container } = show({
      [MESSAGES]: () =>
        fail
          ? Response.json({ error: 'Unavailable' }, { status: 503 })
          : Response.json({ messages: [dmMessage('m1', { content: 'back' })], notificationsMarkedRead: 0 }),
    });
    const retry = () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Try again') ?? null;
    await settle(() => {
      if (retry() === null) throw new Error('no retry yet');
    });
    const failed = container.querySelector('h2')?.textContent;
    fail = false;
    click(retry() as HTMLButtonElement);
    await settle(() => {
      if (!rows(container).includes('lead:Grace Hopper:back')) throw new Error('not reloaded');
    });

    assert({
      given: 'a conversation whose load fails, then Try again',
      should: 'offer a retry, then load it',
      actual: [failed, rows(container)],
      expected: ['Could not load this conversation', ['—Today—', 'lead:Grace Hopper:back']],
    });
  });

  test('earlier messages', async () => {
    const page = Array.from({ length: 50 }, (_, index) =>
      dmMessage(`m${index + 100}`, { createdAt: new Date(Date.UTC(2026, 9, 5, 9, index)).toISOString() }),
    );
    const OLDER = `GET ${dmPaths.messages('dm1', '2026-10-05T09:00:00.000Z')}`;
    const { web, container } = show({
      [MESSAGES]: () => Response.json({ messages: page, notificationsMarkedRead: 0 }),
      [OLDER]: () =>
        Response.json({ messages: [dmMessage('m1', { createdAt: '2026-10-01T09:00:00.000Z', content: 'long ago' })], notificationsMarkedRead: 0 }),
    });
    const older = () =>
      [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('earlier messages')) ?? null;
    await settle(() => {
      if (older() === null) throw new Error('not loaded');
    });
    click(older() as HTMLButtonElement);
    await settle(() => {
      if (!rows(container).includes('lead:Grace Hopper:long ago')) throw new Error('older not loaded');
    });

    assert({
      given: 'a full page of 50 messages, then earlier messages requested',
      should: 'ask for the messages before the oldest one, put them first, and offer no more after a short page',
      actual: [web.count(OLDER), rows(container).slice(0, 2), older()],
      expected: [1, ['—Oct 1—', 'lead:Grace Hopper:long ago'], null],
    });
  });
});
