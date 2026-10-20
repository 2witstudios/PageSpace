// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ResizeHandle } from './resize-handle';
import type { ResizableColumn } from './pane-sizes';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  // jsdom has neither pointer capture nor layout: the row's widths are stubbed below.
  HTMLElement.prototype.setPointerCapture = () => {};
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callback(0);
    return 0;
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const sized = (width: number, grow: boolean) => ({
  'data-width': width,
  style: { flexGrow: grow ? 1 : 0 },
});

/** A row as the shell lays it out: the pane and the seam, with a growing middle beside them. */
const mount = (column: ResizableColumn, onResize: (width: number | null) => void) => {
  const handle = h(ResizeHandle, { column, width: 300, onResize });
  const pane = h('div', { 'data-pane': '', ...sized(300, false) });
  const middle = h('div', sized(800, true));
  act(() => {
    root?.render(h('div', null, ...(column === 'left' ? [pane, handle, middle] : [middle, handle, pane])));
  });
  for (const element of Array.from(container.querySelectorAll<HTMLElement>('[data-width]'))) {
    const width = Number(element.dataset.width);
    element.getBoundingClientRect = () => ({ width }) as DOMRect;
  }
  const seam = container.querySelector('[role="separator"]');
  const paneElement = container.querySelector('[data-pane]');
  if (!(seam instanceof HTMLElement) || !(paneElement instanceof HTMLElement)) throw new Error('no seam');
  const pointer = (type: string, clientX: number) =>
    act(() => {
      seam.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, button: 0 }));
    });
  return { seam, pane: paneElement, pointer };
};

describe('ResizeHandle', () => {
  test('a drag moves the pane, then hands React the width', () => {
    const onResize = vi.fn();
    const { pane, pointer } = mount('left', onResize);
    pointer('pointerdown', 100);
    const resizing = pane.hasAttribute('data-resizing');
    pointer('pointermove', 160);
    const during = pane.style.width;
    pointer('pointerup', 160);
    assert({
      given: 'the sidebar seam dragged 60px right',
      should: 'hold off the width transition, track the pointer, then report 360 and give the width back to React',
      actual: [resizing, during, onResize.mock.calls, pane.style.width, pane.hasAttribute('data-resizing')],
      expected: [true, '360px', [[360]], '', false],
    });
  });

  test('Imago grows leftward and stops where the middle keeps 400px', () => {
    const onResize = vi.fn();
    const { pointer } = mount('imago', onResize);
    pointer('pointerdown', 900);
    pointer('pointermove', 300);
    pointer('pointerup', 300);
    assert({
      given: 'the Imago seam dragged 600px left beside an 800px middle',
      should: 'stop at 700px, leaving the middle 400px',
      actual: onResize.mock.calls,
      expected: [[700]],
    });
  });

  test('a click without a move keeps the token width; a double-click resets', () => {
    const onResize = vi.fn();
    const { seam, pointer } = mount('left', onResize);
    pointer('pointerdown', 100);
    pointer('pointerup', 100);
    const afterClick = [...onResize.mock.calls];
    act(() => {
      seam.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    assert({
      given: 'a press that never moved, then a double-click',
      should: 'report nothing, then ask for the token width back',
      actual: [afterClick, onResize.mock.calls],
      expected: [[], [[null]]],
    });
  });

  test('keys step the seam', () => {
    const onResize = vi.fn();
    const { seam } = mount('left', onResize);
    act(() => {
      seam.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      seam.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }));
    });
    assert({
      given: 'ArrowRight, then Shift+ArrowLeft, on a 300px sidebar',
      should: 'ask for 316 and then 236',
      actual: onResize.mock.calls,
      expected: [[316], [236]],
    });
  });

  test('the seam names itself and its range', () => {
    mount('imago', () => {});
    const seam = container.querySelector('[role="separator"]');
    assert({
      given: 'the Imago seam',
      should: 'be a focusable vertical separator with its bounds and width',
      actual: ['aria-label', 'aria-orientation', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'tabindex'].map((name) =>
        seam?.getAttribute(name),
      ),
      expected: ['Resize Imago', 'vertical', '300', '720', '300', '0'],
    });
  });
});
