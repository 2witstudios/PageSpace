import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { THEME_COOKIE_NAME, parseThemePreference } from './theme-preference';

describe('parseThemePreference', () => {
  test('the classic theme cookie', () => {
    assert({
      given: 'the cookie name',
      should: "be classic's `theme`, so both apps read one preference",
      actual: THEME_COOKIE_NAME,
      expected: 'theme',
    });

    assert({
      given: 'each value classic writes',
      should: 'keep it as the preference',
      actual: ['light', 'dark', 'system'].map(parseThemePreference),
      expected: ['light', 'dark', 'system'],
    });
  });

  test('a missing or untrusted value', () => {
    assert({
      given: 'no cookie, an empty value, a wrong case or markup',
      should: "fall back to system, as classic's layout does",
      actual: [undefined, '', 'Dark', '"><script>', 'light '].map(
        parseThemePreference,
      ),
      expected: ['system', 'system', 'system', 'system', 'system'],
    });
  });
});
