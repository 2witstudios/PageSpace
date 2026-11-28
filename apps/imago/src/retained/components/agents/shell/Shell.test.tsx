// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';
import { useSocketStore } from '@/retained/stores/useSocketStore';

const socket = vi.hoisted(() => ({ value: { connected: false } as object | null }));
vi.mock('@/retained/hooks/useSocket', () => ({ useSocket: () => socket.value }));
vi.mock('./XtermTerminal', () => ({ default: () => <div data-terminal="" /> }));

const { default: Shell, STALLED_AFTER_MS } = await import('./Shell');

const notice = (root: HTMLElement) => root.querySelector('[data-testid="shell-stalled"]');

beforeEach(() => {
  vi.useFakeTimers();
  socket.value = { connected: false };
  useSocketStore.setState({ connectionStatus: 'connecting' });
});

afterEach(() => {
  unmountAll();
  vi.useRealTimers();
});

describe('Shell', () => {
  test('waits on the socket before mounting a terminal', () => {
    socket.value = null;
    const root = mount(<Shell shellId="sh1" />);
    assert({
      given: 'no socket yet',
      should: 'show Connecting… and no terminal',
      actual: [root.querySelector('[data-testid="shell-connecting"]') !== null, root.querySelector('[data-terminal]')],
      expected: [true, null],
    });
  });

  test('says so when the socket never connects, and stops saying so once it does', () => {
    const root = mount(<Shell shellId="sh1" />);
    const early = notice(root);
    act(() => vi.advanceTimersByTime(STALLED_AFTER_MS));
    const stalled = notice(root)?.textContent;
    act(() => useSocketStore.setState({ connectionStatus: 'connected' }));
    assert({
      given: 'a socket that has not connected, then the stall window passing, then a connection',
      should: 'stay quiet at first, then name the realtime server over the mounted terminal, then clear',
      actual: [early, stalled, root.querySelector('[data-terminal]') !== null, notice(root)],
      expected: [null, "Can't reach the realtime server. Retrying…", true, null],
    });
  });
});
