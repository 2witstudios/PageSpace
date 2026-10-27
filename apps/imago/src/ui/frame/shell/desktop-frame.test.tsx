// @vitest-environment jsdom
import { act } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import '@/ui/test-support/dom';
import { isDesktopWindow, useDesktopFrame } from './desktop-frame';

function Marked() {
  return <p data-desktop={useDesktopFrame() ? '' : undefined}>shell</p>;
}

afterEach(() => {
  delete (window as { electron?: unknown }).electron;
});

describe('isDesktopWindow()', () => {
  test('only the Electron bridge that reports itself as the desktop app', () => {
    assert({
      given: 'a browser tab, a bridge that is not the desktop app, and the desktop bridge',
      should: 'count as desktop only for the last',
      actual: [isDesktopWindow(undefined), isDesktopWindow({}), isDesktopWindow({ electron: {} }), isDesktopWindow({ electron: { isDesktop: true } })],
      expected: [false, false, false, true],
    });
  });
});

describe('useDesktopFrame()', () => {
  test('the server render says browser, then hydration reads the bridge', () => {
    (window as { electron?: unknown }).electron = { isDesktop: true };
    const html = renderToString(<Marked />);
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.append(container);
    let root: Root | undefined;
    act(() => {
      root = hydrateRoot(container, <Marked />);
    });
    const after = container.querySelector('p')?.hasAttribute('data-desktop');
    act(() => root?.unmount());
    container.remove();

    assert({
      given: 'the desktop bridge present when the shell hydrates',
      should: 'leave the server markup without the marker and set it once the effect runs',
      actual: [html.includes('data-desktop'), after],
      expected: [false, true],
    });
  });
});
