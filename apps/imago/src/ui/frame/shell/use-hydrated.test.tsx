// @vitest-environment jsdom
import { act } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import '@/ui/test-support/dom';
import { useHydrated } from './use-hydrated';

function Marked() {
  return <p data-hydrated={useHydrated() ? '' : undefined}>shell</p>;
}

describe('useHydrated()', () => {
  test('the server render, then hydration', () => {
    const html = renderToString(<Marked />);
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.append(container);
    const before = container.querySelector('p')?.hasAttribute('data-hydrated');
    let root: Root | undefined;
    act(() => {
      root = hydrateRoot(container, <Marked />);
    });
    const after = container.querySelector('p')?.hasAttribute('data-hydrated');
    act(() => root?.unmount());
    container.remove();

    assert({
      given: 'the server markup, then React hydrating it in the browser',
      should: 'be false in the markup and true once hydrated',
      actual: [html.includes('data-hydrated'), before, after],
      expected: [false, false, true],
    });
  });
});
