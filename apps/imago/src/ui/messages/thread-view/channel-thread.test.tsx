// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { RealtimeProvider } from '@/realtime/realtime-provider';
import { click, mount, press, typeInto, unmountAll } from '@/ui/test-support/dom';
import { fakeRealtime } from '@/ui/test-support/fake-realtime';
import { fakeWeb, type FakeRoute } from '@/ui/test-support/fake-web';
import { channelMessage, channelReaction, inboxChannel } from '../message-model/fixtures';
import { messagePaths } from '../messages-api/messages-api';
import { channelPaths } from '../channel-thread/channel-api';
import { ChannelThread } from './channel-thread';

afterEach(() => {
  unmountAll();
  // jsdom has no scrollIntoView; drop the recorders the scroll tests install.
  delete (Element.prototype as Partial<Element>).scrollIntoView;
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

const CHANNELS = `GET ${messagePaths.driveChannels('d1')}`;
const MESSAGES = `GET ${channelPaths.messages('c1')}`;
const OLDER = `GET ${channelPaths.messages('c1', '2026-10-04T09:00:00.000Z|m1')}`;
const READ = `POST ${channelPaths.read('c1')}`;

const grace = { id: 'u2', name: 'Grace Hopper', image: null };
const ada = { id: 'u1', name: 'Ada Lovelace', image: null };

const routes = (): Record<string, FakeRoute> => ({
  [CHANNELS]: () =>
    Response.json({ items: [inboxChannel('c1', { name: 'launch', unreadCount: 2 })], pagination: { hasMore: false, nextCursor: null } }),
  [MESSAGES]: () =>
    Response.json({
      messages: [
        channelMessage('m2', { createdAt: '2026-10-04T16:00:00.000Z', user: grace, userId: 'u2' }),
        channelMessage('m3', { createdAt: '2026-10-05T09:00:00.000Z', user: ada, userId: 'u1', content: 'morning' }),
        channelMessage('m4', {
          createdAt: '2026-10-05T09:01:00.000Z',
          user: grace,
          userId: 'u2',
          content: 'hi @[Ada Lovelace](u1:user)',
          reactions: [channelReaction('r1', '👍', { id: 'u1', name: 'Ada Lovelace' })],
        }),
        channelMessage('m5', { createdAt: '2026-10-05T09:03:00.000Z', user: grace, userId: 'u2', content: 'and again' }),
      ],
      nextCursor: '2026-10-04T09:00:00.000Z|m1',
      hasMore: true,
      lastReadAt: '2026-10-05T08:00:00.000Z',
    }),
  [OLDER]: () =>
    Response.json({
      messages: [channelMessage('m1', { createdAt: '2026-10-01T09:00:00.000Z', user: grace, userId: 'u2' })],
      nextCursor: null,
      hasMore: false,
      lastReadAt: '2026-10-05T10:00:00.000Z',
    }),
  [READ]: () => Response.json({ success: true, notificationsMarkedRead: 1 }),
});

const show = (table: Record<string, FakeRoute> = routes()) => {
  const web = fakeWeb(table);
  const rt = fakeRealtime();
  const container = mount(
    <ImagoSWRProvider client={web.client}>
      <RealtimeProvider client={rt.client}>
        <ChannelThread driveId="d1" pageId="c1" viewerId="u1" now={() => new Date('2026-10-05T12:00:00.000Z')} markReadDelayMs={20} />
      </RealtimeProvider>
    </ImagoSWRProvider>,
  );
  return { web, container };
};

/** "Load earlier posts" and its loading and retry states; the composer's Send is the other button. */
const olderButton = (container: HTMLElement): HTMLButtonElement | null =>
  [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('earlier posts')) ?? null;

/** Each row: a divider's label, or `lead|follow:<author>:<text>`. */
const rows = (container: HTMLElement) =>
  [...container.querySelectorAll('ol > li')].map((row) =>
    row.getAttribute('role') === 'separator'
      ? `—${row.getAttribute('aria-label')}—`
      : `${row.querySelector('b') ? 'lead' : 'follow'}:${row.querySelector('b')?.textContent ?? row.querySelector('.sr-only')?.textContent}:${row.querySelector('p:last-of-type')?.textContent}`,
  );

describe('ChannelThread', () => {
  test('reading a channel', async () => {
    const { container, web } = show();
    await settle(() => {
      if (container.querySelectorAll('ol > li').length === 0) throw new Error('posts not loaded');
    });
    await settle(() => {
      if (container.querySelector('h1')?.textContent !== 'launch') throw new Error('name not loaded');
    });
    await settle(() => {
      if (web.count(READ) === 0) throw new Error('not marked read');
    });

    assert({
      given: 'a channel with posts yesterday and today, read up to 8:00 today, with a mention and a reaction',
      should: 'title it from the drive’s channels, divide the days in UTC against the injected clock, mark New after the watermark, group the five-minute run, and mark the channel read once',
      actual: [
        container.querySelector('h1')?.textContent,
        rows(container),
        container.querySelector('[data-mention="user"]')?.textContent,
        container.querySelector('ul[aria-label="Reactions"] li')?.getAttribute('aria-label'),
        web.count(READ),
      ],
      expected: [
        'launch',
        [
          '—Yesterday—',
          'lead:Grace Hopper:post m2',
          '—Today—',
          'lead:Ada Lovelace:morning',
          '—New—',
          'lead:Grace Hopper:hi @Ada Lovelace',
          'follow:Grace Hopper said: :and again',
        ],
        '@Ada Lovelace',
        '👍 1, including you',
        1,
      ],
    });
  });

  test('opening at where unread begins', async () => {
    // jsdom lays nothing out; record what the thread asks to bring into view.
    const scrolled: [string | null, ScrollIntoViewOptions | boolean | undefined][] = [];
    Element.prototype.scrollIntoView = function (this: Element, options?: ScrollIntoViewOptions | boolean) {
      scrolled.push([this.getAttribute('aria-label') ?? this.textContent, options]);
    };
    const { container } = show();
    await settle(() => {
      if (container.querySelectorAll('ol > li').length === 0) throw new Error('posts not loaded');
    });
    click(olderButton(container) as HTMLButtonElement);
    await settle(() => {
      if (olderButton(container) !== null) throw new Error('older not loaded');
    });

    assert({
      given: 'a channel opened with unread posts, then its earlier posts loaded',
      should: 'bring the New divider to the top once, and not jump when earlier posts arrive',
      actual: scrolled,
      expected: [['New', { block: 'start' }]],
    });
  });

  test('opening a channel read to the end', async () => {
    const scrolled: (string | null)[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.querySelector('p:last-of-type')?.textContent ?? null);
    };
    const web = fakeWeb({
      ...routes(),
      [MESSAGES]: () =>
        Response.json({
          messages: [channelMessage('m1', { content: 'first' }), channelMessage('m2', { content: 'last', createdAt: '2026-10-05T09:30:00.000Z' })],
          nextCursor: null,
          hasMore: false,
          lastReadAt: '2026-10-05T10:00:00.000Z',
        }),
    });
    const rt = fakeRealtime();
    const container = mount(
      <ImagoSWRProvider client={web.client}>
        <RealtimeProvider client={rt.client}>
          <ChannelThread driveId="d1" pageId="c1" viewerId="u1" now={() => new Date('2026-10-05T12:00:00.000Z')} markReadDelayMs={20} />
        </RealtimeProvider>
      </ImagoSWRProvider>,
    );
    await settle(() => {
      if (container.querySelectorAll('ol > li').length === 0) throw new Error('posts not loaded');
    });

    assert({
      given: 'a channel with nothing unread',
      should: 'open at its newest post',
      actual: scrolled,
      expected: ['last'],
    });
  });

  test('earlier posts', async () => {
    const { container, web } = show();
    await settle(() => {
      if (olderButton(container) === null) throw new Error('not loaded');
    });
    click(olderButton(container) as HTMLButtonElement);
    await settle(() => {
      if (!rows(container).includes('lead:Grace Hopper:post m1')) throw new Error('older not loaded');
    });

    assert({
      given: 'earlier posts loaded with a later watermark in their answer',
      should: 'put them first under their own day, keep New where the channel opened with it, and offer no more',
      actual: [rows(container).slice(0, 3), rows(container).includes('—New—'), olderButton(container), web.count(OLDER)],
      expected: [['—Oct 1—', 'lead:Grace Hopper:post m1', '—Yesterday—'], true, null, 1],
    });
  });

  describe('edge states', () => {
    const notFound = (container: HTMLElement) => {
      const object = container.querySelector('[data-not-found]');
      return [object?.querySelector('h2')?.textContent, object?.querySelector('a')?.getAttribute('href'), object?.querySelector('a')?.textContent];
    };

    test('a channel the server refuses', async () => {
      const { container } = show({ ...routes(), [MESSAGES]: () => Response.json({ error: 'Forbidden' }, { status: 403 }) });
      await settle(() => {
        if (!container.querySelector('[data-not-found]')) throw new Error('no not-found');
      });
      assert({
        given: 'a channel id the server answers 403 for',
        should: 'draw the not-found object with a way back to the drive’s messages',
        actual: notFound(container),
        expected: ['Channel not found', '/d1/messages', 'Back to Messages'],
      });
    });

    test('an id that is not one of the drive’s channels', async () => {
      const { container } = show({
        ...routes(),
        [CHANNELS]: () => Response.json({ items: [], pagination: { hasMore: false, nextCursor: null } }),
      });
      await settle(() => {
        if (!container.querySelector('[data-not-found]')) throw new Error('no not-found');
      });
      assert({
        given: 'a page id the drive does not list as a channel',
        should: 'draw the not-found object',
        actual: notFound(container)[0],
        expected: 'Channel not found',
      });
    });

    test('a channel that will not load, then loads', async () => {
      let calls = 0;
      const table = routes();
      const { container, web } = show({
        ...table,
        [MESSAGES]: (request) => {
          calls += 1;
          return calls === 1 ? Response.json({ error: 'ECONNRESET to 10.0.0.7' }, { status: 502 }) : table[MESSAGES](request);
        },
      });
      await settle(() => {
        if (!container.querySelector('[role="alert"] button')) throw new Error('no retry');
      });
      const alert = container.querySelector('[role="alert"]');
      const failed = [alert?.querySelector('h2')?.textContent, alert?.textContent?.includes('10.0.0.7')];
      click(alert?.querySelector('button') as HTMLButtonElement);
      await settle(() => {
        if (container.querySelectorAll('ol > li').length === 0) throw new Error('posts not loaded');
      });
      assert({
        given: 'a 502 with server text, then Try again',
        should: 'draw the retryable error without that text, then the posts the retry loads',
        actual: [failed, web.count(MESSAGES), container.querySelector('[role="alert"]')],
        expected: [['Could not load this channel', false], 2, null],
      });
    });
  });
});

const SEND = `POST ${channelPaths.send('c1')}`;

/** A route answer the test releases when it chooses, to order the POST against the socket echo. */
const deferred = () => {
  let release: (response: Response) => void = () => {};
  const answer = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { answer, release };
};

/** The viewer's post as apps/web stores and broadcasts it, nonce echoed. */
const stored = (nonce: unknown, content: string) => ({
  ...channelMessage('m9', { createdAt: '2026-10-05T12:00:01.000Z', user: ada, userId: 'u1', content }),
  clientNonce: nonce,
});

const showLive = (extra: Record<string, FakeRoute> = {}) => {
  const web = fakeWeb({ ...routes(), ...extra });
  const rt = fakeRealtime();
  const container = mount(
    <ImagoSWRProvider client={web.client}>
      <RealtimeProvider client={rt.client}>
        <ChannelThread driveId="d1" pageId="c1" viewerId="u1" now={() => new Date('2026-10-05T12:00:00.000Z')} markReadDelayMs={20} />
      </RealtimeProvider>
    </ImagoSWRProvider>,
  );
  const field = () => container.querySelector('textarea') as HTMLTextAreaElement;
  return { web, rt, container, field };
};

const loaded = (container: HTMLElement) =>
  settle(() => {
    if (container.querySelectorAll('ol > li').length === 0) throw new Error('posts not loaded');
  });

/** The rows after the loaded page's, with `(sending)` on a post not yet confirmed. */
const tail = (container: HTMLElement) =>
  [...container.querySelectorAll('ol > li')]
    .slice(7)
    .map((row, index) => `${rows(container)[7 + index]}${row.hasAttribute('data-pending') ? ' (sending)' : ''}`);

const sentNonce = (web: ReturnType<typeof fakeWeb>): unknown =>
  (web.writes().find((request) => request.url === channelPaths.send('c1'))?.body as { clientNonce?: unknown } | undefined)
    ?.clientNonce;

describe('ChannelThread sending and receiving', () => {
  test('sending: the response first, then the socket echo', async () => {
    const post = deferred();
    const { web, rt, container, field } = showLive({ [SEND]: () => post.answer });
    await loaded(container);
    typeInto(field(), 'ship it @[Grace Hopper](u2:user)');
    press(field(), 'Enter');
    await settle(() => {
      if (web.count(SEND) === 0) throw new Error('not sent');
    });
    const optimistic = tail(container);
    const draftAfterSend = field().value;
    const nonce = sentNonce(web);

    post.release(Response.json(stored(nonce, 'ship it @[Grace Hopper](u2:user)'), { status: 201 }));
    await settle(() => {
      if (container.querySelector('[data-pending]')) throw new Error('not confirmed');
    });
    const confirmed = tail(container);
    rt.emit('new_message', stored(nonce, 'ship it @[Grace Hopper](u2:user)'));

    assert({
      given: 'a post typed with a stored-format mention and sent with Enter, the POST answering before the broadcast',
      should:
        'POST it with the CSRF token and a nonce, show it at once as sending with the draft cleared, swap in the server copy with its mention, and not duplicate it on the echo',
      actual: [
        web.writes().filter((request) => request.url === channelPaths.send('c1')),
        typeof nonce === 'string' && nonce.length > 0,
        optimistic,
        draftAfterSend,
        confirmed,
        tail(container),
        container.querySelector('ol > li:last-child [data-mention="user"]')?.textContent,
      ],
      expected: [
        [
          {
            method: 'POST',
            url: '/api/channels/c1/messages',
            csrf: 'tok-1',
            body: { content: 'ship it @[Grace Hopper](u2:user)', clientNonce: nonce },
          },
        ],
        true,
        ['lead:Ada Lovelace:ship it @Grace Hopper (sending)'],
        '',
        ['lead:Ada Lovelace:ship it @Grace Hopper'],
        ['lead:Ada Lovelace:ship it @Grace Hopper'],
        '@Grace Hopper',
      ],
    });
  });

  test('sending: the socket echo first, then the response', async () => {
    const post = deferred();
    const { web, rt, container, field } = showLive({ [SEND]: () => post.answer });
    await loaded(container);
    typeInto(field(), 'echo wins');
    press(field(), 'Enter');
    await settle(() => {
      if (web.count(SEND) === 0) throw new Error('not sent');
    });
    const nonce = sentNonce(web);
    rt.emit('new_message', stored(nonce, 'echo wins'));
    const echoed = tail(container);
    post.release(Response.json(stored(nonce, 'echo wins'), { status: 201 }));
    await settle(() => {
      if (web.requests.length === 0) throw new Error('never');
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));

    assert({
      given: 'the broadcast of the viewer’s post landing before its POST resolves',
      should: 'confirm the post on the echo and ignore the late response',
      actual: [echoed, tail(container)],
      expected: [['lead:Ada Lovelace:echo wins'], ['lead:Ada Lovelace:echo wins']],
    });
  });

  test('a failed send', async () => {
    const { container, field } = showLive({
      [SEND]: () => Response.json({ error: 'You need edit permission to send messages in this channel' }, { status: 403 }),
    });
    await loaded(container);
    typeInto(field(), 'not allowed');
    press(field(), 'Enter');
    await settle(() => {
      if (!container.querySelector('[role="alert"]')) throw new Error('no error yet');
    });

    assert({
      given: 'apps/web refusing the post',
      should: 'take the sending post back out, put the text back in the composer and say it was not sent',
      actual: [tail(container), field().value, container.querySelector('[role="alert"]')?.textContent],
      expected: [[], 'not allowed', 'Could not send your post. You need edit permission to send messages in this channel'],
    });
  });

  test('posts from others arrive live', async () => {
    const { web, rt, container } = showLive();
    await loaded(container);
    await settle(() => {
      if (web.count(READ) === 0) throw new Error('not marked read');
    });
    const socket = rt.live()[0];
    const joins = socket?.emitted.filter(([event]) => event === 'join_channel');

    const live = channelMessage('m10', { createdAt: '2026-10-05T12:00:05.000Z', content: 'hello from Grace', user: grace, userId: 'u2' });
    rt.emit('new_message', live);
    rt.emit('new_message', live);
    rt.emit('new_message', channelMessage('m11', { pageId: 'c2', content: 'other channel' }));
    rt.emit('new_message', channelMessage('m12', { parentId: 'm5', content: 'in a thread', createdAt: '2026-10-05T12:00:06.000Z' }));
    await settle(() => {
      if (web.count(READ) < 2) throw new Error('not marked read again');
    });
    const shown = tail(container);
    rt.emit('connect');
    unmountAll();

    assert({
      given: 'the channel open, then another member’s post broadcast twice, another channel’s post, a thread reply, a reconnect and leaving',
      should:
        'join the channel’s room, show the post once, ignore the rest, mark the channel read again, rejoin after the reconnect and leave the room on the way out',
      actual: [
        joins,
        shown,
        web.count(READ),
        socket?.emitted.map(([event, pageId]) => `${String(event)} ${String(pageId)}`),
      ],
      expected: [
        [['join_channel', 'c1']],
        ['lead:Grace Hopper:hello from Grace'],
        2,
        ['join_channel c1', 'join_channel c1', 'leave_channel c1'],
      ],
    });
  });
});
