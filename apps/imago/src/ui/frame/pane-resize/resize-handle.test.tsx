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

/** A row as the shell lays it out: the pane and its seam (the handle no longer measures the row). */
const mount = (column: ResizableColumn, onResize: (width: number | null) => void, max = 480) => {
  const render = (docked: boolean) =>
    act(() => {
      const pane = h('div', { key: 'pane', 'data-pane': '' });
      const handle = docked ? h(ResizeHandle, { key: 'seam', column, width: 300, size: undefined, max, onResize }) : null;
      root?.render(h('div', null, ...(column === 'left' ? [pane, handle] : [handle, pane])));
    });
  render(true);
  const seam = container.querySelector('[role="separator"]');
  const paneElement = container.querySelector('[data-pane]');
  if (!(seam instanceof HTMLElement) || !(paneElement instanceof HTMLElement)) throw new Error('no seam');
  const pointer = (type: string, clientX: number) =>
    act(() => {
      seam.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, button: 0 }));
    });
  return { seam, pane: paneElement, pointer, undock: () => render(false) };
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
    const { pointer } = mount('imago', onResize, 700);
    pointer('pointerdown', 900);
    pointer('pointermove', 300);
    pointer('pointerup', 300);
    assert({
      given: 'the Imago seam dragged 600px left with 700px the most the middle can spare',
      should: 'stop at 700px',
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

  test('the seam going mid-drag leaves nothing behind', () => {
    const onResize = vi.fn();
    const { pane, pointer, undock } = mount('left', onResize);
    pointer('pointerdown', 100);
    pointer('pointermove', 160);
    undock();
    assert({
      given: 'the sidebar undocked while its seam was being dragged',
      should: 'drop the inline width, the held transition and the page-wide select-none, and save nothing',
      actual: [pane.style.width, pane.hasAttribute('data-resizing'), document.body.classList.contains('select-none'), onResize.mock.calls],
      expected: ['', false, false, []],
    });
  });

  test('a second pointer during a drag is ignored', () => {
    const onResize = vi.fn();
    const { pointer } = mount('left', onResize);
    pointer('pointerdown', 100);
    pointer('pointermove', 140);
    pointer('pointerdown', 500);
    pointer('pointermove', 160);
    pointer('pointerup', 160);
    assert({
      given: 'a second press while the seam is held',
      should: 'keep the first drag and its origin',
      actual: onResize.mock.calls,
      expected: [[360]],
    });
  });

  test('the seam names itself and its range', () => {
    mount('imago', () => {}, 640);
    const seam = container.querySelector('[role="separator"]');
    assert({
      given: 'the Imago seam',
      should: 'be a focusable vertical separator with its bounds and width',
      actual: ['aria-label', 'aria-orientation', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'tabindex'].map((name) =>
        seam?.getAttribute(name),
      ),
      expected: ['Resize Imago', 'vertical', '300', '640', '300', '0'],
    });
  });
});
