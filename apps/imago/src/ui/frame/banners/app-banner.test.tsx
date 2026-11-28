// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import '@/ui/test-support/dom';
import { AppBanner } from './app-banner';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const setOnline = (online: boolean) =>
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });

describe('AppBanner', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setOnline(true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    router.refresh.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('the offline banner while offline, removed once back online', () => {
    act(() => root.render(<AppBanner />));
    const shownOnline = container.querySelector('[data-banner="offline"]') !== null;

    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event('offline'));
    });
    const offline = container.querySelector('[data-banner="offline"]');
    const copy = offline?.textContent ?? '';

    act(() => {
      setOnline(true);
      window.dispatchEvent(new Event('online'));
    });
    const shownAgain = container.querySelector('[data-banner="offline"]') !== null;

    assert({
      given: 'the navigator going offline, then back online',
      should: 'show "You’re offline." with Try again while offline and remove the strip once online',
      actual: [shownOnline, offline !== null, copy.includes('You’re offline.'), copy.includes('Try again'), shownAgain],
      expected: [false, true, true, true, false],
    });
  });

  test('Try again refreshes the route', () => {
    act(() => {
      setOnline(false);
      root.render(<AppBanner />);
    });
    const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Try again');
    act(() => button?.click());

    assert({
      given: 'the offline banner and a click on Try again',
      should: 'refresh the current route',
      actual: router.refresh.mock.calls.length,
      expected: 1,
    });
  });
});
