// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '../../test-support/dom';

const fake = vi.hoisted(() => {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  return {
    handlers,
    mutate: vi.fn(),
    socket: {
      on: (event: string, handler: (payload: unknown) => void) => {
        handlers.set(event, (handlers.get(event) ?? new Set()).add(handler));
      },
      off: (event: string, handler: (payload: unknown) => void) => {
        handlers.get(event)?.delete(handler);
      },
    },
    emit: (event: string, payload: unknown) => {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
  };
});
vi.mock('@/retained/stores/useSocketStore', () => ({
  useSocketStore: (select: (state: { socket: typeof fake.socket }) => unknown) => select({ socket: fake.socket }),
}));
vi.mock('swr', () => ({ useSWRConfig: () => ({ mutate: fake.mutate }) }));

const { useLiveDrives } = await import('./use-live-drives');

afterEach(unmountAll);

function Probe() {
  useLiveDrives();
  return null;
}

describe('useLiveDrives()', () => {
  test('drive events refetch the drive list', () => {
    mount(h(Probe));
    act(() => {
      fake.emit('drive:updated', { driveId: 'd1', operation: 'updated' });
      fake.emit('drive:updated', { driveId: 'd1', operation: 'updated', resourceType: 'command' });
      fake.emit('drive:member_added', { driveId: 'd2', operation: 'member_added' });
    });
    assert({
      given: 'a drive update, a command change on the same channel, then a new membership',
      should: 'refetch /api/drives for the drive update and the membership, not the command',
      actual: fake.mutate.mock.calls.map(([key]) => key),
      expected: ['/api/drives', '/api/drives'],
    });
  });

  test('unmounting', () => {
    const view = mount(h(Probe));
    act(() => view.remove());
    unmountAll();
    assert({
      given: 'the shell gone',
      should: 'leave no drive listeners on the socket',
      actual: [...fake.handlers.values()].reduce((total, set) => total + set.size, 0),
      expected: 0,
    });
  });
});
