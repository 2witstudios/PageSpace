import { renderToStaticMarkup } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { renderPageUnavailable } from './page-unavailable';

describe('renderPageUnavailable()', () => {
  test('a link that cannot resolve to an openable page', () => {
    const html = renderToStaticMarkup(renderPageUnavailable({ homeDriveId: 'home-1' }));

    assert({
      given: 'a Home drive to browse',
      should: 'say the page is unavailable, offer Back to Chat, Browse Files and Ask Imago',
      actual: [
        html.includes('This page isn’t available'),
        html.includes('>Back to Chat<'),
        html.includes('href="/home-1/files"'),
        html.includes('>Browse Files<'),
        html.includes('>Ask Imago<'),
      ],
      expected: [true, true, true, true, true],
    });
  });

  test('the Home drive is not known', () => {
    const html = renderToStaticMarkup(renderPageUnavailable({ homeDriveId: null }));

    assert({
      given: 'no Home drive',
      should: 'leave Browse Files out rather than point it nowhere',
      actual: html.includes('Browse Files'),
      expected: false,
    });
  });
});
