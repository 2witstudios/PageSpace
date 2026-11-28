import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { applyTextSize } from './apply-text-size';

/** Hand-written stand-in for <html>: a plain object recording dataset writes. */
const createRoot = (dataset: Record<string, string | undefined> = {}) => ({ dataset });

describe('applyTextSize', () => {
  test('writes each size onto the target', () => {
    const sizes = (['small', 'default', 'large', 'larger'] as const).map((size) => {
      const root = createRoot();
      applyTextSize(root, size);
      return root.dataset.textSize;
    });

    assert({
      given: 'each text size',
      should: 'set data-text-size to that same value, which scales the root font size',
      actual: sizes,
      expected: ['small', 'default', 'large', 'larger'],
    });
  });

  test('touches nothing but the text-size key', () => {
    const root = createRoot({ theme: 'dark', textSize: 'small' });
    applyTextSize(root, 'larger');

    assert({
      given: 'a target carrying the theme too',
      should: 'leave the theme as it was',
      actual: root.dataset,
      expected: { theme: 'dark', textSize: 'larger' },
    });
  });
});
