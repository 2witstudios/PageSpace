import { renderToStaticMarkup } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { renderNotFound } from './not-found.render';

describe('renderNotFound()', () => {
  test('a drive the viewer cannot open', () => {
    const html = renderToStaticMarkup(
      renderNotFound({ title: 'Drive not found', detail: 'It does not exist, or you do not have access to it.', homeHref: '/home-1' }),
    );

    assert({
      given: 'a title, a detail and the Home drive',
      should: 'render the not-found object with both lines and a way back to Home',
      actual: html,
      expected:
        '<div class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center" data-not-found="">' +
        '<h2 class="m-0 text-md font-semibold text-ink">Drive not found</h2>' +
        '<p class="m-0 text-sm text-ink-muted">It does not exist, or you do not have access to it.</p>' +
        '<a class="text-sm font-medium text-accent" href="/home-1">Go to your Home drive</a>' +
        '</div>',
    });
  });

  test('no Home drive yet', () => {
    assert({
      given: 'no Home drive to return to',
      should: 'offer no link',
      actual: renderToStaticMarkup(renderNotFound({ title: 'Drive not found', detail: 'Gone.', homeHref: null })).includes('<a'),
      expected: false,
    });
  });
});
