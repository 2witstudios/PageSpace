// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { Pane } from './pane';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
});

/** A real client root holding one Pane; render() swaps its props. */
const mount = () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = (open: boolean, width: string, children: ReactNode) =>
    act(() => {
      root.render(h(Pane, { open, width, children }));
    });
  const pane = (): HTMLElement => {
    const element = container.firstElementChild;
    if (!(element instanceof HTMLElement)) throw new Error('no pane rendered');
    return element;
  };
  /** The browser fires this when the width transition finishes. */
  const finish = (target: Element = pane()) =>
    act(() => {
      target.dispatchEvent(new Event('transitionend', { bubbles: true }));
    });
  return { render, pane, finish };
};

describe('Pane', () => {
  test('closing keeps the last children until the width transition ends', () => {
    const { render, pane, finish } = mount();
    render(true, 'w-list-pane', h('p', null, 'tree'));
    render(false, 'w-0', null);
    const during = pane().innerHTML;
    const inertDuring = pane().hasAttribute('inert');
    finish();

    assert({
      given: 'an open pane closed with no children',
      should: 'keep showing its last children while it slides shut, then drop them',
      actual: [during, inertDuring, pane().getAttribute('aria-hidden'), pane().innerHTML],
      expected: ['<p>tree</p>', true, 'true', ''],
    });
  });

  test('a bubbled transitionend from inside the pane', () => {
    const { render, pane, finish } = mount();
    render(true, 'w-list-pane', h('p', null, 'tree'));
    render(false, 'w-0', null);
    const inner = pane().querySelector('p');
    if (inner === null) throw new Error('kept content missing');
    finish(inner);

    assert({
      given: 'a transition inside the pane ending while the pane itself still slides',
      should: 'keep the content until the pane’s own width transition ends',
      actual: pane().innerHTML,
      expected: '<p>tree</p>',
    });
  });

  test('reopening before the transition ends', () => {
    const { render, pane, finish } = mount();
    render(true, 'w-list-pane', h('p', null, 'old'));
    render(false, 'w-0', null);
    render(true, 'w-list-pane', h('p', null, 'new'));
    finish();

    assert({
      given: 'a closing pane opened again with new children before it finished',
      should: 'show the new children, reachable, and keep them after the transition',
      actual: [pane().innerHTML, pane().hasAttribute('inert'), pane().hasAttribute('aria-hidden')],
      expected: ['<p>new</p>', false, false],
    });
  });

  test('an open pane follows its children', () => {
    const { render, pane, finish } = mount();
    render(true, 'w-tree-pane', h('p', null, 'one'));
    render(true, 'w-list-pane', h('p', null, 'two'));
    finish();

    assert({
      given: 'an open pane whose width and children change',
      should: 'show the current children and never drop them on transitionend',
      actual: pane().innerHTML,
      expected: '<p>two</p>',
    });
  });

  test('the same node across stages', () => {
    const { render, pane } = mount();
    render(true, 'w-list-pane', h('p', null, 'list'));
    const before = pane();
    render(false, 'w-0', null);
    render(true, 'w-tree-pane', h('p', null, 'tree'));

    assert({
      given: 'a pane opened, closed and reopened at another width',
      should: 'stay one mounted node that only changes its width class',
      actual: [pane() === before, pane().className.endsWith('w-tree-pane')],
      expected: [true, true],
    });
  });

  test('after the transition a closed pane shows its current children', () => {
    const { render, pane, finish } = mount();
    render(true, 'w-stage-object', h('p', null, 'document'));
    render(false, 'w-0', h('p', null, 'route'));
    const during = pane().innerHTML;
    finish();

    assert({
      given: 'a pane closed with new children (the route below the shell)',
      should: 'keep the last open children while closing, then show the current ones',
      actual: [during, pane().innerHTML],
      expected: ['<p>document</p>', '<p>route</p>'],
    });
  });

  test('a pane that starts closed', () => {
    const { render, pane } = mount();
    render(false, 'w-0', h('p', null, 'route'));
    render(false, 'w-0', h('p', null, 'next route'));

    assert({
      given: 'a pane that was never open',
      should: 'hold nothing back and show its current children, out of reach',
      actual: [pane().innerHTML, pane().hasAttribute('inert')],
      expected: ['<p>next route</p>', true],
    });
  });

  test('the route stays mounted through a close', () => {
    const { render, pane, finish } = mount();
    const route = h('p', null, 'route');
    render(true, 'w-stage-object', route);
    const node = pane().firstElementChild;
    render(false, 'w-0', route);
    finish();

    assert({
      given: 'the same children element kept across open, close and transitionend',
      should: 'keep the same DOM node mounted, never dropping and remounting it',
      actual: pane().firstElementChild === node && node !== null,
      expected: true,
    });
  });

  test('reduced motion', () => {
    // jsdom has no transitions; what reduced motion changes is the duration,
    // so the stylesheet must keep transitionend firing (a real browser proof
    // is recorded in the handoff).
    const css = readFileSync(join(__dirname, '../../../app/globals.css'), 'utf8');
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    const { render, pane, finish } = mount();
    render(true, 'w-list-pane', h('p', null, 'tree'));
    render(false, 'w-0', null);
    finish();

    assert({
      given: 'prefers-reduced-motion and a pane closing',
      should: 'cut transitions to 0.01ms (not 0s, which never fires transitionend) and drop the content when it ends',
      actual: [
        block.includes('transition-duration: 0.01ms !important'),
        /transition-duration:\s*0s/.test(block),
        pane().innerHTML,
      ],
      expected: [true, false, ''],
    });
  });
});
