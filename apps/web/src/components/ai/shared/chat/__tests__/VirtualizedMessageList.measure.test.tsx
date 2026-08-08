import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import type { UIMessage } from 'ai';

/**
 * One invariant: this component never throws away the virtualizer's size cache.
 *
 * `virtualizer.measure()` clears the ENTIRE itemSizeCache, so every row falls
 * back to `estimateSize`, `getTotalSize()` collapses, and — because the
 * container is `contain: strict` with height = getTotalSize() — the browser
 * clamps scrollTop upward by the full delta, dumping the viewport near the top
 * of the thread. That was the "chat jumps to the top on every tool call" bug,
 * fired by a `messages` array that gets a new identity on every streamed part.
 *
 * A pane resize is the case that looks like it deserves a wipe — a width change
 * reflows rows that are unmounted and have no observer of their own. It doesn't:
 * mounted rows re-measure themselves through virtual-core's observer, and for
 * unmounted rows a stale real height is a better estimate than the flat fallback
 * a wipe would install. Wiping there reproduces the same jump, so these tests
 * pin the width path shut too.
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

function makeScrollElement(width: number) {
  const element = document.createElement('div');
  Object.defineProperty(element, 'clientWidth', { value: width, configurable: true });
  return element;
}

/** Mimics a pane resize: change the width, then let any observer fire. */
function resizeTo(element: HTMLElement, width: number) {
  Object.defineProperty(element, 'clientWidth', { value: width, configurable: true });
  act(() => {
    observerCallbacks.forEach((fire) => fire());
    // Long enough to clear any settle/debounce window a future change might add.
    vi.advanceTimersByTime(2000);
  });
}

function renderList(messages: UIMessage[], element: HTMLElement) {
  const props = {
    messages,
    renderMessage: (m: UIMessage) => <div key={m.id}>{m.id}</div>,
    scrollRef: { current: element as HTMLElement | null },
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

  describe('never resets the size cache', () => {
    it('given a new messages array identity with unchanged ids, should not reset it', () => {
      const messages = makeMessages(['m1', 'm2', 'm3']);
      const { rerenderWith } = renderList(messages, makeScrollElement(800));

      // What a stream tick does: same messages, brand-new array.
      rerenderWith([...messages]);
      act(() => {
        vi.advanceTimersByTime(2000);
      });

      expect(measure).not.toHaveBeenCalled();
    });

    it('given an appended message, should not reset it', () => {
      const messages = makeMessages(['m1', 'm2', 'm3']);
      const { rerenderWith } = renderList(messages, makeScrollElement(800));

      rerenderWith([...messages, ...makeMessages(['m4'])]);
      act(() => {
        vi.advanceTimersByTime(2000);
      });

      expect(measure).not.toHaveBeenCalled();
    });

    it('given a pane resized to a new width, should not reset it', () => {
      // Mounted rows re-measure through virtual-core's own observer, and stale
      // heights beat the flat estimate a wipe would install for unmounted rows.
      const element = makeScrollElement(800);
      renderList(makeMessages(['m1', 'm2', 'm3']), element);

      resizeTo(element, 500);

      expect(measure).not.toHaveBeenCalled();
    });

    it('given a pane dragged across many widths, should not reset it', () => {
      const element = makeScrollElement(800);
      renderList(makeMessages(['m1', 'm2', 'm3']), element);

      [780, 740, 700, 660, 620].forEach((width) => resizeTo(element, width));

      expect(measure).not.toHaveBeenCalled();
    });

    it('given a pane collapsed to zero width, should not reset it', () => {
      const element = makeScrollElement(800);
      renderList(makeMessages(['m1', 'm2', 'm3']), element);

      resizeTo(element, 0);

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
