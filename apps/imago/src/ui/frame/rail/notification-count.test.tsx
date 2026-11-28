// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { RealtimeProvider } from '@/realtime/realtime-provider';
import { fakeRealtime } from '@/ui/test-support/fake-realtime';
import { fakeWeb, type FakeRoute } from '@/ui/test-support/fake-web';
import { NOTIFICATION_COUNT, useNotificationCount } from './notification-count';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
});

// SWR resolves outside React's event loop; waiting inside act() flushes the
// state updates it causes.
const settle = (check: () => void, timeout = 1000): Promise<void> =>
  act(() => vi.waitFor(check, { timeout, interval: 5 }));

const COUNT = `GET ${NOTIFICATION_COUNT}`;

const mount = (routes: Record<string, FakeRoute>, probe: ReactNode) => {
  const web = fakeWeb(routes);
  const rt = fakeRealtime();
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  act(() => {
    root.render(
      <ImagoSWRProvider client={web.client}>
        <RealtimeProvider client={rt.client}>{probe}</RealtimeProvider>
      </ImagoSWRProvider>,
    );
  });
  return { web, rt };
};

describe('useNotificationCount() (IMC-1.4)', () => {
  test('the bell badge', async () => {
    const seen: { count?: number } = {};
    function Probe() {
      seen.count = useNotificationCount();
      return null;
    }
    const { web } = mount({ [COUNT]: () => Response.json({ count: 3 }) }, <Probe />);
    await settle(() => {
      if (seen.count !== 3) throw new Error('count not loaded');
    });

    assert({
      given: "apps/web's countOnly body",
      should: 'read the unread count',
      actual: [seen.count, web.count(COUNT)],
      expected: [3, 1],
    });
  });

  test('after a reconnect, refetches the count the dropped socket missed', async () => {
    let body = { count: 3 };
    const seen: { count?: number } = {};
    function Probe() {
      seen.count = useNotificationCount();
      return null;
    }
    const { rt, web } = mount({ [COUNT]: () => Response.json(body) }, <Probe />);
    await settle(() => {
      if (seen.count !== 3) throw new Error('count not loaded');
    });

    // A notification lands while the transport is down: its notification:new is lost.
    body = { count: 5 };
    rt.emit('connect');
    await settle(() => {
      if (seen.count !== 5) throw new Error('count not refetched');
    });

    assert({
      given: 'the socket connecting again after the count loaded',
      should: 'refetch the count once',
      actual: [seen.count, web.count(COUNT)],
      expected: [5, 2],
    });
  });

  test('a first connect before the count has loaded', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: { count?: number } = {};
    function Probe() {
      seen.count = useNotificationCount();
      return null;
    }
    const { rt, web } = mount(
      {
        [COUNT]: async () => {
          await gate;
          return Response.json({ count: 3 });
        },
      },
      <Probe />,
    );

    rt.emit('connect');
    release();
    await settle(() => {
      if (seen.count !== 3) throw new Error('count not loaded');
    });

    assert({
      given: 'the socket connecting while the first load is still in flight',
      should: 'not fetch the count a second time',
      actual: web.count(COUNT),
      expected: 1,
    });
  });
});
