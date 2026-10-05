import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { applyTheme } from './apply-theme';

/** Hand-written stand-in for <html>: a plain object recording dataset writes. */
const createRoot = (dataset: Record<string, string | undefined> = {}) => ({
  dataset,
});

describe('applyTheme', () => {
  test('writes each preference onto the target', () => {
    const themes = (['light', 'dark', 'system'] as const).map((preference) => {
      const root = createRoot();
      applyTheme(root, preference);
      return root.dataset.theme;
    });

    assert({
      given: 'each theme preference',
      should: 'set data-theme to that same value, which selects color-scheme',
      actual: themes,
      expected: ['light', 'dark', 'system'],
    });
  });

  test('touches nothing but the theme key', () => {
    const root = createRoot({ theme: 'dark', density: 'compact' });
    applyTheme(root, 'light');

    assert({
      given: 'a target carrying other data attributes',
      should: 'leave them as they were',
      actual: root.dataset,
      expected: { theme: 'light', density: 'compact' },
    });
  });
});
