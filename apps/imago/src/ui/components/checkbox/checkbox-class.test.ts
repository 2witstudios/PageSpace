import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { checkboxClass } from './checkbox-class';

const base =
  'inline-flex size-checkbox flex-none cursor-pointer items-center justify-center rounded-sm border transition-colors duration-120 ease-standard';

describe('checkboxClass', () => {
  test('ticked', () => {
    assert({
      given: 'a ticked checkbox',
      should: 'fill the 16px box with the accent and show the check in accent ink',
      actual: checkboxClass(true),
      expected: `${base} border-accent bg-accent text-accent-ink`,
    });
  });

  test('open', () => {
    assert({
      given: 'an open checkbox',
      should: 'outline the box with the strong border and hide the check',
      actual: checkboxClass(false),
      expected: `${base} border-border-strong text-transparent hover:border-ink-muted`,
    });
  });

  test('read-only', () => {
    assert({
      given: 'a checkbox the viewer may not change, ticked and open',
      should: 'drop the pointer and the hover border, keeping the state it shows',
      actual: [checkboxClass(true, true), checkboxClass(false, true)],
      expected: [
        `${base.replace('cursor-pointer', 'cursor-default')} border-accent bg-accent text-accent-ink`,
        `${base.replace('cursor-pointer', 'cursor-default')} border-border-strong text-transparent`,
      ],
    });
  });
});
