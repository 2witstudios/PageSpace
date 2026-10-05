import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { renderToString } from 'react-dom/server';
import { renderListOpener, renderListPane } from './list-pane.render';

const noop = () => {};

describe('renderListPane()', () => {
  test('the wide list', () => {
    const html = renderToString(
      renderListPane({ variant: 'list', title: 'Files', closeHref: '/drive-1', onCollapse: noop, children: null }),
    );
    assert({
      given: 'a stage-2 list',
      should: 'be a named region whose × steps back to the drive chat as a link',
      actual: [
        html.includes('aria-label="Files"'),
        html.includes('w-list-pane'),
        /<a(?=[^>]*href="\/drive-1")(?=[^>]*aria-label="Close Files")[^>]*>/.test(html),
        html.includes('<button'),
      ],
      expected: [true, true, true, false],
    });
  });

  test('the narrow tree', () => {
    const html = renderToString(
      renderListPane({ variant: 'tree', title: 'Files', closeHref: '/drive-1', onCollapse: noop, children: null }),
    );
    assert({
      given: 'a stage-3 tree beside an object',
      should: 'hide rather than leave, so its × is a button, not a link',
      actual: [
        html.includes('w-tree-pane'),
        /<button(?=[^>]*type="button")(?=[^>]*aria-label="Hide Files")[^>]*>/.test(html),
        html.includes('<a'),
      ],
      expected: [true, true, false],
    });
  });

  test('icon semantics', () => {
    const html = renderToString(
      renderListPane({ variant: 'tree', title: 'Tasks', closeHref: '/drive-1', onCollapse: noop, children: null }),
    );
    assert({
      given: 'the × icon',
      should: 'be lucide at stroke 1.5 / 16px, hidden from assistive technology',
      actual: [html.includes('stroke-width="1.5"'), html.includes('width="16"'), html.includes('aria-hidden="true"')],
      expected: [true, true, true],
    });
  });
});

describe('renderListOpener()', () => {
  test('the hamburger', () => {
    const html = renderToString(renderListOpener({ title: 'Files', onOpen: noop }));
    assert({
      given: 'a hidden list',
      should: 'offer a named, borderless hamburger that shows it again',
      actual: [/<button(?=[^>]*type="button")(?=[^>]*aria-label="Show Files")[^>]*>/.test(html), html.includes('lucide-menu')],
      expected: [true, true],
    });
  });
});
