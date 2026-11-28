import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  focusCountClass,
  focusEmptyClass,
  focusGroupClass,
  focusHeadingClass,
  focusViewClass,
} from './focus-view-class';

describe('focus view classes', () => {
  test('the column and its groups', () => {
    assert({
      given: 'the Focus view, a group, its heading, a count and an empty line',
      should: 'stack spaced groups headed in faint small type',
      actual: [focusViewClass, focusGroupClass, focusHeadingClass, focusCountClass, focusEmptyClass],
      expected: [
        'flex w-full flex-col gap-4',
        'flex flex-col gap-1',
        'flex items-center gap-2 truncate px-2 pt-2 text-2xs font-semibold text-ink-faint',
        'font-medium text-ink-muted',
        'px-2 text-sm text-ink-faint',
      ],
    });
  });
});
