import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { inlineAddFieldClass, inlineAddRestClass } from './inline-add-class';

describe('inline add classes', () => {
  test('resting control', () => {
    assert({
      given: 'the resting "+ Add" row',
      should: 'be a quiet full-width row that lifts on hover',
      actual: inlineAddRestClass,
      expected:
        'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-row-y text-left text-sm text-ink-faint transition-colors duration-120 ease-standard hover:bg-surface-overlay hover:text-ink',
    });
  });

  test('open field', () => {
    assert({
      given: 'the open field',
      should: 'be a full-width row-height input with the strong border',
      actual: inlineAddFieldClass,
      expected:
        'w-full rounded-lg border border-border-strong bg-background px-2 py-row-y text-sm text-ink outline-none placeholder:text-ink-faint',
    });
  });
});
