import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { buttonClass } from './button-class';

// 36px tall (h-control), md radius (8px), 14px medium label.
const base =
  'inline-flex h-control cursor-pointer items-center justify-center gap-2 rounded-md border text-base leading-tight font-medium transition-colors duration-120 ease-standard';

describe('buttonClass()', () => {
  test('primary', () => {
    assert({
      given: 'the primary variant',
      should: 'add the accent fill and its hover to the 36px md base',
      actual: buttonClass('primary'),
      expected: `${base} border-transparent bg-accent px-4 text-accent-ink hover:bg-accent-strong`,
    });
  });

  test('secondary', () => {
    assert({
      given: 'the secondary variant',
      should: 'add a transparent fill with the strong border',
      actual: buttonClass('secondary'),
      expected: `${base} border-border-strong bg-transparent px-4 text-ink hover:border-ink-muted`,
    });
  });

  test('ghost', () => {
    assert({
      given: 'the ghost variant',
      should: 'add muted ink with tighter padding at the same height',
      actual: buttonClass('ghost'),
      expected: `${base} border-transparent bg-transparent px-3 text-ink-muted hover:bg-surface-overlay hover:text-ink`,
    });
  });
});
