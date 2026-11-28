import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  TEXT_SIZES,
  TEXT_SIZE_COOKIE_NAME,
  parseTextSize,
  serializeTextSizeCookie,
  textSizeFromCookies,
} from './text-size-preference';

describe('TEXT_SIZES', () => {
  test('the choices the control offers', () => {
    assert({
      given: 'the text-size list',
      should: 'offer small, default, large and larger, smallest first',
      actual: TEXT_SIZES,
      expected: ['small', 'default', 'large', 'larger'],
    });
  });
});

describe('parseTextSize', () => {
  test('each size imago writes', () => {
    assert({
      given: 'each value the control writes',
      should: 'keep it as the size',
      actual: ['small', 'default', 'large', 'larger'].map(parseTextSize),
      expected: ['small', 'default', 'large', 'larger'],
    });
  });

  test('a missing or untrusted value', () => {
    assert({
      given: 'no cookie, an empty value, a wrong case, padding or markup',
      should: 'fall back to the default size',
      actual: [undefined, '', 'Large', 'large ', '"><script>', 'huge'].map(parseTextSize),
      expected: ['default', 'default', 'default', 'default', 'default', 'default'],
    });
  });
});

describe('textSizeFromCookies', () => {
  test('a cookie string such as document.cookie', () => {
    assert({
      given: 'the text-size cookie among others, a prefix-named cookie, an unknown value and none',
      should: 'read only the imago-text-size pair through the trust boundary',
      actual: [
        textSizeFromCookies('session=abc; imago-text-size=large; theme=dark'),
        textSizeFromCookies('imago-text-size=small'),
        textSizeFromCookies('my-imago-text-size=larger; imago-text-size=default'),
        textSizeFromCookies('my-imago-text-size=larger'),
        textSizeFromCookies('imago-text-size=huge'),
        textSizeFromCookies(''),
      ],
      expected: ['large', 'small', 'default', 'default', 'default', 'default'],
    });
  });
});

describe('serializeTextSizeCookie', () => {
  test('the cookie imago writes', () => {
    assert({
      given: 'each size and no cookie domain',
      should: 'write imago-text-size on path=/, for a year, SameSite=Lax, host-only',
      actual: TEXT_SIZES.map((size) => serializeTextSizeCookie(size, { domain: undefined })),
      expected: [
        'imago-text-size=small; path=/; max-age=31536000; SameSite=Lax',
        'imago-text-size=default; path=/; max-age=31536000; SameSite=Lax',
        'imago-text-size=large; path=/; max-age=31536000; SameSite=Lax',
        'imago-text-size=larger; path=/; max-age=31536000; SameSite=Lax',
      ],
    });
  });

  test('a shared cookie domain', () => {
    assert({
      given: 'a cookie domain',
      should: 'scope the cookie to it, as the theme cookie is',
      actual: serializeTextSizeCookie('large', { domain: '.pagespace.ai' }),
      expected: 'imago-text-size=large; path=/; max-age=31536000; SameSite=Lax; domain=.pagespace.ai',
    });
  });

  test('the cookie name', () => {
    assert({
      given: 'the cookie name',
      should: 'be imago-text-size',
      actual: TEXT_SIZE_COOKIE_NAME,
      expected: 'imago-text-size',
    });
  });
});
