import { renderToStaticMarkup } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { DmHead } from './dm-head';

describe('DmHead', () => {
  test('a conversation with a name and options', () => {
    const html = renderToStaticMarkup(<DmHead title="Dana Whitfield" options={<button type="button">opts</button>} />);

    assert({
      given: 'a conversation title and an options control',
      should: 'render the Direct messages crumb, the name as the current page and the options',
      actual: {
        dmCrumb: html.includes('href="/dm"') && html.includes('Direct messages'),
        current: html.includes('aria-current="page">Dana Whitfield</span>'),
        options: html.includes('<button type="button">opts</button>'),
        share: html.includes('Share'),
      },
      expected: { dmCrumb: true, current: true, options: true, share: false },
    });
  });

  test('the new-message head', () => {
    const html = renderToStaticMarkup(<DmHead title="New message" />);

    assert({
      given: 'no options control',
      should: 'render the new-message crumb and no options slot',
      actual: { current: html.includes('>New message</span>'), slot: html.includes('pl-2') },
      expected: { current: true, slot: false },
    });
  });
});
