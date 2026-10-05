// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { RealtimeProvider } from '@/realtime/realtime-provider';
import { fakeRealtime } from '@/ui/test-support/fake-realtime';
import { fakeWeb, type FakeRoute } from '@/ui/test-support/fake-web';
import { channelMessage } from '../message-model/fixtures';
import type { ChannelMessageResponse } from '../message-model/post';
import { channelPaths } from './channel-api';
import type { ThreadState } from './channel-thread-state';
import { useChannelThread } from './use-channel-thread';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  setVisibility('visible');
});

const setVisibility = (state: DocumentVisibilityState) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
};

/**
 * Polls `check` in short act() ticks: a reducer update lands in act's queue
 * and renders when that act ends, so one long act would never show it.
 */
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

/** Lets timers and fetches run for a while, for asserting that nothing happened. */
const idle = (ms: number): Promise<void> => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const DELAY = 30;

const messagesRoute =
  (rows: readonly ChannelMessageResponse[], extra: Record<string, unknown> = {}): FakeRoute =>
  () =>
    Response.json({ messages: rows, nextCursor: null, hasMore: false, lastReadAt: '2026-10-05T08:00:00.000Z', ...extra });

const readRoute: FakeRoute = () => Response.json({ success: true, notificationsMarkedRead: 0 });

type Seen = { state?: ThreadState; loadOlder?: () => void };

const Probe = ({ seen, pageId }: { seen: Seen; pageId: string }) => {
  const thread = useChannelThread({ pageId, viewerId: 'u1', markReadDelayMs: DELAY });
  seen.state = thread.state;
  seen.loadOlder = thread.loadOlder;
  return null;
};

const show = (routes: Record<string, FakeRoute>, pageId = 'c1', strict = false) => {
  const web = fakeWeb(routes);
  const rt = fakeRealtime();
  const seen: Seen = {};
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  const render = (id: string) => {
    const tree = (
      <ImagoSWRProvider client={web.client}>
        <RealtimeProvider client={rt.client}>
          <Probe seen={seen} pageId={id} />
        </RealtimeProvider>
      </ImagoSWRProvider>
    );
    act(() => {
      root.render(strict ? <StrictMode>{tree}</StrictMode> : (tree as ReactNode));
    });
  };
  render(pageId);
  return { web, seen, root, render };
};

const ready = (seen: Seen) =>
  settle(() => {
    if (seen.state?.status !== 'ready') throw new Error(`not ready: ${seen.state?.status}`);
  });

const READ_C1 = `POST ${channelPaths.read('c1')}`;
const READ_C2 = `POST ${channelPaths.read('c2')}`;

describe('useChannelThread', () => {
  test('loading the channel', async () => {
    const { seen } = show({
      [`GET ${channelPaths.messages('c1')}`]: messagesRoute([channelMessage('m1'), channelMessage('m2')], {
        nextCursor: 'cur-1',
        hasMore: true,
      }),
      [READ_C1]: readRoute,
    });
    const first = seen.state?.status;
    await ready(seen);
    assert({
      given: 'a channel opened',
      should: 'be loading, then hold its posts, the older cursor and the watermark from /api/channels/[pageId]/messages',
      actual: [first, seen.state?.posts.map((post) => post.id), seen.state?.nextCursor, seen.state?.lastReadAt],
      expected: ['loading', ['m1', 'm2'], 'cur-1', '2026-10-05T08:00:00.000Z'],
    });
  });

  test('marking it read, debounced, once per open', async () => {
    const { seen, web } = show({
      [`GET ${channelPaths.messages('c1')}`]: messagesRoute([channelMessage('m1')], { nextCursor: 'cur-1', hasMore: true }),
      [`GET ${channelPaths.messages('c1', 'cur-1')}`]: messagesRoute([channelMessage('m0')]),
      [READ_C1]: readRoute,
    });
    await ready(seen);
    const beforeDelay = web.count(READ_C1);
    await settle(() => {
      if (web.count(READ_C1) === 0) throw new Error('not marked');
    });
    act(() => seen.loadOlder?.());
    await settle(() => {
      if (seen.state?.posts.length !== 2) throw new Error('older not loaded');
    });
    await idle(DELAY * 3);
    assert({
      given: 'a channel loaded and viewed past the debounce, then its earlier posts loaded',
      should: 'not mark it read at once, then POST the read route exactly once, with CSRF',
      actual: [beforeDelay, web.count(READ_C1), web.writes().map((write) => [write.url, write.csrf])],
      expected: [0, 1, [['/api/channels/c1/read', 'tok-1']]],
    });
  });

  test('leaving before the debounce', async () => {
    const { seen, web, render } = show({
      [`GET ${channelPaths.messages('c1')}`]: messagesRoute([channelMessage('m1')]),
      [`GET ${channelPaths.messages('c2')}`]: messagesRoute([channelMessage('m9', { pageId: 'c2' })]),
      [READ_C1]: readRoute,
      [READ_C2]: readRoute,
    });
    await ready(seen);
    render('c2');
    await settle(() => {
      if (web.count(READ_C2) === 0) throw new Error('c2 not marked');
    });
    await idle(DELAY * 3);
    assert({
      given: 'a channel left before its read debounce fired, and the next one viewed',
      should: 'never mark the left channel read, and mark the one being viewed',
      actual: [web.count(READ_C1), web.count(READ_C2), seen.state?.posts.map((post) => post.id)],
      expected: [0, 1, ['m9']],
    });
  });

  test('a hidden tab', async () => {
    setVisibility('hidden');
    const { seen, web } = show({
      [`GET ${channelPaths.messages('c1')}`]: messagesRoute([channelMessage('m1')]),
      [READ_C1]: readRoute,
    });
    await ready(seen);
    await idle(DELAY * 3);
    const whileHidden = web.count(READ_C1);
    setVisibility('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle(() => {
      if (web.count(READ_C1) === 0) throw new Error('not marked');
    });
    assert({
      given: 'a channel loaded in a background tab, then the tab shown',
      should: 'not mark unseen posts read until the tab is visible, then mark it once',
      actual: [whileHidden, web.count(READ_C1)],
      expected: [0, 1],
    });
  });

  test('hiding and showing the tab after the mark', async () => {
    const { seen, web } = show({
      [`GET ${channelPaths.messages('c1')}`]: messagesRoute([channelMessage('m1')]),
      [READ_C1]: readRoute,
    });
    await ready(seen);
    await settle(() => {
      if (web.count(READ_C1) === 0) throw new Error('not marked');
    });
    for (const state of ['hidden', 'visible', 'hidden', 'visible'] as const) {
      setVisibility(state);
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
    }
    await idle(DELAY * 3);
    assert({
      given: 'a channel already marked read, then the tab hidden and shown twice in the same open',
      should: 'not mark it read again: once per open',
      actual: web.count(READ_C1),
      expected: 1,
    });
  });

  test('a channel that fails to load', async () => {
    const { seen, web } = show({
      [`GET ${channelPaths.messages('c1')}`]: () => Response.json({ error: 'Access denied' }, { status: 403 }),
      [READ_C1]: readRoute,
    });
    await settle(() => {
      if (seen.state?.status !== 'error') throw new Error('not failed');
    });
    await idle(DELAY * 3);
    assert({
      given: 'a channel whose posts could not be loaded',
      should: 'show the error and never mark it read, since nothing was viewed',
      actual: [seen.state?.status, web.count(READ_C1)],
      expected: ['error', 0],
    });
  });

  test('strict mode', async () => {
    const { seen, web } = show(
      {
        [`GET ${channelPaths.messages('c1')}`]: messagesRoute([channelMessage('m1')]),
        [READ_C1]: readRoute,
      },
      'c1',
      true,
    );
    await ready(seen);
    await settle(() => {
      if (web.count(READ_C1) === 0) throw new Error('not marked');
    });
    await idle(DELAY * 3);
    assert({
      given: 'the hook under StrictMode’s double effects',
      should: 'still mark the channel read once',
      actual: web.count(READ_C1),
      expected: 1,
    });
  });

  test('a failed older page', async () => {
    const { seen } = show({
      [`GET ${channelPaths.messages('c1')}`]: messagesRoute([channelMessage('m1')], { nextCursor: 'cur-1', hasMore: true }),
      [`GET ${channelPaths.messages('c1', 'cur-1')}`]: () => Response.json({ error: 'boom' }, { status: 500 }),
      [READ_C1]: readRoute,
    });
    await ready(seen);
    act(() => seen.loadOlder?.());
    await settle(() => {
      if (seen.state?.older !== 'error') throw new Error('older not failed');
    });
    assert({
      given: 'earlier posts that fail to load',
      should: 'keep the posts shown and the cursor to retry with',
      actual: [seen.state?.posts.map((post) => post.id), seen.state?.nextCursor],
      expected: [['m1'], 'cur-1'],
    });
  });
});
