import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { renderPane } from './pane.render';

const noop = () => {};

describe('renderPane()', () => {
  test('an open pane', () => {
    const html = renderToString(
      renderPane({ open: true, width: 'w-list-pane', content: h('p', null, 'tree'), onTransitionEnd: noop }),
    );
    assert({
      given: 'an open pane',
      should: 'carry its width, the pane motion and its content, reachable',
      actual: [
        html.includes('w-list-pane'),
        html.includes('pane-motion'),
        html.includes('<p>tree</p>'),
        html.includes('inert'),
        html.includes('aria-hidden'),
      ],
      expected: [true, true, true, false, false],
    });
  });

  test('a closed pane', () => {
    const html = renderToString(
      renderPane({ open: false, width: 'w-0', content: h('p', null, 'kept'), onTransitionEnd: noop }),
    );
    assert({
      given: 'a closed pane still holding its last content',
      should: 'be inert, hidden from assistive technology, and still show the content',
      actual: [html.includes('inert=""'), html.includes('aria-hidden="true"'), html.includes('<p>kept</p>')],
      expected: [true, true, true],
    });
  });

  test('a slot name', () => {
    const html = renderToString(
      renderPane({ open: true, width: 'w-chat-pane', slot: 'chat', content: null, onTransitionEnd: noop }),
    );
    assert({
      given: 'a pane for the chat slot',
      should: 'name the slot for tests and devtools',
      actual: html.includes('data-slot="chat"'),
      expected: true,
    });
  });
});
