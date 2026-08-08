import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import type { UIMessage } from 'ai';

/**
 * Two halves of one invariant about when the virtualizer's size cache may be
 * thrown away.
 *
 * NEVER on a `messages` change. That array gets a brand-new identity on every
 * streamed part, and `virtualizer.measure()` clears the ENTIRE itemSizeCache:
 * every row falls back to `estimateSize`, `getTotalSize()` collapses, and —
 * because the container is `contain: strict` with height = getTotalSize() — the
 * browser clamps scrollTop upward by the full delta, dumping the viewport near
 * the top of the thread. That was the "chat jumps to the top on every tool
 * call" bug.
 *
 * ALWAYS on a settled width change. The chat lives inside a ResizablePanelGroup,
 * so dragging a sidebar handle reflows every message. Rows that are currently
 * mounted self-correct through their own ResizeObserver, but rows outside the
 * render window have no observer and would keep their pre-resize heights
 * indefinitely.
 */

const measure = vi.fn();
const measureElement = vi.fn();
let capturedOptions: Record<string, unknown> = {};

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: Record<string, unknown>) => {
    capturedOptions = opts;
    return {
      measure,
      measureElement,
      getVirtualItems: () => [],
      getTotalSize: () => 0,
      scrollToIndex: vi.fn(),
    };
  },
}));

// Imported after the mock so the component picks up the mocked hook.
const { VirtualizedMessageList } = await import('../VirtualizedMessageList');

/** jsdom has no ResizeObserver; this one lets a test fire the callback by hand. */
const observerCallbacks: Array<() => void> = [];
class TestResizeObserver {
  constructor(callback: () => void) {
    observerCallbacks.push(callback);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function makeMessages(ids: string[]): UIMessage[] {
  return ids.map((id) => ({
    id,
    role: 'assistant',
    parts: [{ type: 'text', text: `body of ${id}` }],
  })) as unknown as UIMessage[];
}

/** A scroll element whose clientWidth the test controls. */
function makeScrollElement(width: number) {
  const element = document.createElement('div');
  setWidth(element, width);
  return element;
}

function setWidth(element: HTMLElement, width: number) {
  Object.defineProperty(element, 'clientWidth', { value: width, configurable: true });
}

/** Mimics a pane resize: change the width, then let the observer fire. */
function resizeTo(element: HTMLElement, width: number) {
  setWidth(element, width);
  act(() => {
    observerCallbacks.forEach((fire) => fire());
  });
}

function settle() {
  act(() => {
    vi.advanceTimersByTime(500);
  });
}

function renderList(messages: UIMessage[], element: HTMLElement) {
  const scrollRef = { current: element as HTMLElement | null };
  const props = {
    messages,
    renderMessage: (m: UIMessage) => <div key={m.id}>{m.id}</div>,
    scrollRef,
    estimatedRowHeight: 100,
  };
  const view = render(<VirtualizedMessageList {...props} />);
  return {
    ...view,
    rerenderWith: (next: UIMessage[]) =>
      view.rerender(<VirtualizedMessageList {...props} messages={next} />),
  };
}

const getItemKey = () => capturedOptions.getItemKey as (index: number) => unknown;

describe('VirtualizedMessageList measurement stability', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    measure.mockClear();
    observerCallbacks.length = 0;
    capturedOptions = {};
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('on a messages change', () => {
    it('given a new array identity with unchanged ids, should not reset the size cache', () => {
      const messages = makeMessages(['m1', 'm2', 'm3']);
      const { rerenderWith } = renderList(messages, makeScrollElement(800));

      // What a stream tick does: same messages, brand-new array.
      rerenderWith([...messages]);
      settle();

      expect(measure).not.toHaveBeenCalled();
    });

    it('given an appended message, should not reset the size cache', () => {
      const messages = makeMessages(['m1', 'm2', 'm3']);
      const { rerenderWith } = renderList(messages, makeScrollElement(800));

      rerenderWith([...messages, ...makeMessages(['m4'])]);
      settle();

      expect(measure).not.toHaveBeenCalled();
    });
  });

  describe('on a width change', () => {
    it('given the pane settled at a new width, should reset the size cache once', () => {
      const element = makeScrollElement(800);
      renderList(makeMessages(['m1', 'm2', 'm3']), element);

      resizeTo(element, 500);
      settle();

      expect(measure).toHaveBeenCalledTimes(1);
    });

    it('given a width still being dragged, should not reset the size cache until it settles', () => {
      const element = makeScrollElement(800);
      renderList(makeMessages(['m1', 'm2', 'm3']), element);

      resizeTo(element, 700);
      act(() => {
        vi.advanceTimersByTime(50);
      });

      expect(measure).not.toHaveBeenCalled();
    });

    it('given many widths during one drag, should reset the size cache only once', () => {
      const element = makeScrollElement(800);
      renderList(makeMessages(['m1', 'm2', 'm3']), element);

      [780, 740, 700, 660, 620].forEach((width) => {
        resizeTo(element, width);
        act(() => {
          vi.advanceTimersByTime(20);
        });
      });
      settle();

      expect(measure).toHaveBeenCalledTimes(1);
    });

    it('given a height-only change, should not reset the size cache', () => {
      const element = makeScrollElement(800);
      renderList(makeMessages(['m1', 'm2', 'm3']), element);

      // Observer fires (the element resized vertically) but the width is the same.
      resizeTo(element, 800);
      settle();

      expect(measure).not.toHaveBeenCalled();
    });

    it('given the pane collapsed to zero width, should not reset the size cache against a hidden element', () => {
      const element = makeScrollElement(800);
      renderList(makeMessages(['m1', 'm2', 'm3']), element);

      resizeTo(element, 0);
      settle();

      expect(measure).not.toHaveBeenCalled();
    });
  });

  describe('size cache keys', () => {
    it('given an index, should key by that message id rather than by position', () => {
      renderList(makeMessages(['m1', 'm2', 'm3']), makeScrollElement(800));

      expect(getItemKey()(0)).toBe('m1');
      expect(getItemKey()(1)).toBe('m2');
      expect(getItemKey()(2)).toBe('m3');
    });

    it('given a prepended older page, should still map each existing message to its own id', () => {
      const messages = makeMessages(['m1', 'm2', 'm3']);
      const { rerenderWith } = renderList(messages, makeScrollElement(800));

      rerenderWith([...makeMessages(['older1']), ...messages]);

      // Positions all shifted by one; without getItemKey the cached height for
      // index 1 would still be attributed to m2's old slot.
      expect(getItemKey()(0)).toBe('older1');
      expect(getItemKey()(1)).toBe('m1');
      expect(getItemKey()(2)).toBe('m2');
    });

    it('given messages with missing or blank ids, should fall back to the index rather than collide on one entry', () => {
      renderList(
        [
          { role: 'assistant', parts: [] },
          { id: '', role: 'assistant', parts: [] },
        ] as unknown as UIMessage[],
        makeScrollElement(800)
      );

      expect(getItemKey()(0)).toBe(0);
      expect(getItemKey()(1)).toBe(1);
    });
  });
});
