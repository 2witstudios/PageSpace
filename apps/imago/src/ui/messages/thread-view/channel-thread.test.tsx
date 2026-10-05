// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { RealtimeProvider } from '@/realtime/realtime-provider';
import { click, mount, unmountAll } from '@/ui/test-support/dom';
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

const show = () => {
  const web = fakeWeb(routes());
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
    click(container.querySelector('button') as HTMLButtonElement);
    await settle(() => {
      if (container.querySelector('button') !== null) throw new Error('older not loaded');
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
      if (container.querySelector('button') === null) throw new Error('not loaded');
    });
    click(container.querySelector('button') as HTMLButtonElement);
    await settle(() => {
      if (!rows(container).includes('lead:Grace Hopper:post m1')) throw new Error('older not loaded');
    });

    assert({
      given: 'earlier posts loaded with a later watermark in their answer',
      should: 'put them first under their own day, keep New where the channel opened with it, and offer no more',
      actual: [rows(container).slice(0, 3), rows(container).includes('—New—'), container.querySelector('button'), web.count(OLDER)],
      expected: [['—Oct 1—', 'lead:Grace Hopper:post m1', '—Yesterday—'], true, null, 1],
    });
  });
});
