import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { renderPaneHeader } from './pane-header';

describe('renderPaneHeader()', () => {
  test('title and actions', () => {
    const html = renderToString(
      renderPaneHeader({ title: h('span', null, 'Files'), actions: h('button', { type: 'button' }, 'Close') }),
    );
    assert({
      given: 'a pane title and a trailing action',
      should: 'render both inside the shared 52px header',
      actual: [html.includes('Files'), html.includes('Close'), html.includes('h-pane-header')],
      expected: [true, true, true],
    });
  });

  test('the leading slot', () => {
    const html = renderToString(
      renderPaneHeader({ title: h('span', null, 'Files'), leading: h('button', { type: 'button' }, 'Open') }),
    );
    assert({
      given: 'a header with a leading control',
      should: 'render the control first, beside the title rather than over it',
      actual: html.indexOf('Open') >= 0 && html.indexOf('Open') < html.indexOf('Files'),
      expected: true,
    });
  });

  test('title only', () => {
    const html = renderToString(renderPaneHeader({ title: 'Settings' }));
    assert({
      given: 'a header with only a title',
      should: 'still render the title and no leading slot',
      actual: [html.includes('Settings'), html.includes('data-leading')],
      expected: [true, false],
    });
  });
});
