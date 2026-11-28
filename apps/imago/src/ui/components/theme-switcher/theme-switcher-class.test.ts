import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { optionClass, switcherClass } from './theme-switcher-class';

const base =
  'inline-flex cursor-pointer items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium transition-colors duration-120 ease-standard';

describe('theme switcher classes', () => {
  test('the group', () => {
    assert({
      given: 'the switcher group',
      should: 'sit on a sunken, bordered md-radius track',
      actual: switcherClass,
      expected:
        'inline-flex gap-1 rounded-md border border-border bg-surface-sunken p-1',
    });
  });

  test('the checked and unchecked options', () => {
    assert({
      given: 'a checked and an unchecked option',
      should: 'raise the checked one and quiet the other',
      actual: [optionClass(true), optionClass(false)],
      expected: [
        `${base} border-border bg-surface-raised text-ink shadow-1`,
        `${base} border-transparent bg-transparent text-ink-muted hover:text-ink`,
      ],
    });
  });
});
