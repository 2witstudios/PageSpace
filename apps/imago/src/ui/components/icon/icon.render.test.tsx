import { renderToString } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { renderIcon } from './icon.render';

describe('renderIcon()', () => {
  test("PageSpace's thin line at 16px", () => {
    const html = renderToString(renderIcon({ name: 'close' }));
    assert({
      given: 'an icon with no size',
      should: 'render a 16px square lucide svg with a 1.5 stroke',
      actual: [
        /<svg[^>]* width="16"/.test(html),
        /<svg[^>]* height="16"/.test(html),
        /<svg[^>]* stroke-width="1.5"/.test(html),
        html.includes('lucide-x'),
      ],
      expected: [true, true, true, true],
    });
  });

  test('requested size', () => {
    const html = renderToString(renderIcon({ name: 'search', size: 18 }));
    assert({
      given: 'a search icon at size 18',
      should: 'draw the lucide search glyph in an 18px box, still at stroke 1.5',
      actual: [
        html.includes('lucide-search'),
        /<svg[^>]* width="18"/.test(html),
        /<svg[^>]* stroke-width="1.5"/.test(html),
      ],
      expected: [true, true, true],
    });
  });

  test('decorative by default', () => {
    const html = renderToString(renderIcon({ name: 'files' }));
    assert({
      given: 'an icon without a label',
      should: 'hide from assistive technology and take no role',
      actual: [html.includes('aria-hidden="true"'), html.includes('role=')],
      expected: [true, false],
    });
  });

  test('labelled', () => {
    const html = renderToString(renderIcon({ name: 'share', label: 'Share' }));
    assert({
      given: 'an icon with a label',
      should: 'render an image role with the accessible name, not hidden',
      actual: [
        html.includes('role="img"'),
        html.includes('aria-label="Share"'),
        html.includes('aria-hidden'),
      ],
      expected: [true, true, false],
    });
  });

  test('caller class', () => {
    const html = renderToString(
      renderIcon({ name: 'check', className: 'text-accent' }),
    );
    assert({
      given: 'a caller class',
      should: 'keep the icon a non-shrinking block and append the caller class',
      actual: /class="[^"]*block shrink-0 text-accent"/.test(html),
      expected: true,
    });
  });
});
