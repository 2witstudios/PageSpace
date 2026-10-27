import type { TouchEvent } from 'react';
import { describe, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { assert } from './riteway';
import { usePullToRefresh } from '../usePullToRefresh';

vi.mock('@/lib/haptics', () => ({ triggerHaptic: vi.fn() }));

/**
 * Builds the shape the task list actually renders: a container that never
 * scrolls wrapping the list that does. Before the edge sensor learned to look
 * past the container, this arrangement reported "at the top" forever.
 */
const buildNestedScroller = ({ innerScrollTop }: { innerScrollTop: number }) => {
  const container = document.createElement('div');
  const inner = document.createElement('div');
  const row = document.createElement('div');

  inner.appendChild(row);
  container.appendChild(inner);
  document.body.appendChild(container);

  // The container is exactly as tall as its content — nothing to scroll.
  Object.defineProperty(container, 'scrollHeight', { value: 500, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true });
  container.scrollTop = 0;

  // The list inside it is the real scroller, and it is scrolled down.
  Object.defineProperty(inner, 'scrollHeight', { value: 2000, configurable: true });
  Object.defineProperty(inner, 'clientHeight', { value: 500, configurable: true });
  inner.scrollTop = innerScrollTop;
  inner.style.overflowY = 'auto';

  return { container, inner, row };
};

const touch = (clientY: number, target: EventTarget) =>
  ({ touches: [{ clientY }], target, preventDefault: () => {} }) as unknown as TouchEvent;

const setup = (innerScrollTop: number) => {
  const nodes = buildNestedScroller({ innerScrollTop });
  const { result } = renderHook(() =>
    usePullToRefresh({ direction: 'top', onRefresh: async () => {} })
  );
  result.current.containerRef.current = nodes.container;
  return { ...nodes, result };
};

describe('usePullToRefresh — where the edge is measured', () => {
  it('does not pull when the list under the finger is scrolled away from the top', () => {
    const { row, result } = setup(800);

    act(() => {
      result.current.touchHandlers.onTouchStart(touch(100, row));
      result.current.touchHandlers.onTouchMove(touch(200, row));
    });

    assert({
      given: 'a swipe down inside a list that is scrolled down, in a container that never scrolls',
      should: 'not start a pull, because the list — not the container — is the edge that counts',
      actual: result.current.isPulling,
      expected: false,
    });
  });

  it('pulls when that same list is at its top', () => {
    const { row, result } = setup(0);

    act(() => {
      result.current.touchHandlers.onTouchStart(touch(100, row));
      result.current.touchHandlers.onTouchMove(touch(200, row));
    });

    assert({
      given: 'a swipe down inside a list already at its top',
      should: 'start a pull',
      actual: result.current.isPulling,
      expected: true,
    });
  });

  it('does not pull when the list only reaches the top part-way through the swipe', () => {
    const { inner, row, result } = setup(300);

    act(() => {
      // Finger goes down while still scrolled into the list…
      result.current.touchHandlers.onTouchStart(touch(100, row));
      // …the browser scrolls it to the top during the same gesture…
      inner.scrollTop = 0;
      // …and the finger keeps travelling down.
      result.current.touchHandlers.onTouchMove(touch(260, row));
    });

    assert({
      given: 'a scroll-up flick that lands at the top mid-gesture',
      should: 'not convert into a refresh, which is what competes with the scroll',
      actual: result.current.isPulling,
      expected: false,
    });
  });
});
