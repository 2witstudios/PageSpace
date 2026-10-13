import { renderToString } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { renderIcon, type IconProps } from './icon.render';

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

  test('the stroke and the accessible name are locked', () => {
    // The type omits these props; a cast stands in for a caller that slips
    // them through anyway (a spread of untyped props).
    const forced = { strokeWidth: 3, absoluteStrokeWidth: true, 'aria-hidden': true } as unknown as Partial<IconProps>;
    const thick = renderToString(renderIcon({ name: 'close', ...forced }));
    const labelled = renderToString(renderIcon({ name: 'close', label: 'Close', ...forced }));
    assert({
      given: 'a caller passing strokeWidth, absoluteStrokeWidth and aria-hidden',
      should: 'keep the 1.5 stroke and keep a labelled icon visible to assistive technology',
      actual: [
        /<svg[^>]* stroke-width="1.5"/.test(thick),
        /<svg[^>]* stroke-width="1.5"/.test(labelled),
        labelled.includes('aria-hidden'),
        labelled.includes('aria-label="Close"'),
      ],
      expected: [true, true, false, true],
    });
  });
});

describe('IconProps', () => {
  test('the locked props are not part of the type', () => {
    // Never called: `tsc` checks each line, and fails if IconProps lets the
    // prop back in (the directive would then be unused).
    const locked = (): void => {
      // @ts-expect-error the stroke is fixed at 1.5
      renderIcon({ name: 'close', strokeWidth: 3 });
      // @ts-expect-error lucide's absolute stroke would bypass it
      renderIcon({ name: 'close', absoluteStrokeWidth: true });
      // @ts-expect-error the label decides whether the icon is hidden
      renderIcon({ name: 'close', 'aria-hidden': true });
    };
    assert({
      given: 'strokeWidth, absoluteStrokeWidth and aria-hidden',
      should: 'be rejected by the compiler (checked by typecheck)',
      actual: typeof locked,
      expected: 'function',
    });
  });
});
