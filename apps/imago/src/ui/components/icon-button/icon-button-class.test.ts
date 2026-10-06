import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { iconButtonClass } from './icon-button-class';

// 32px square (size-8), md radius (8px).
const base =
  'inline-flex size-8 cursor-pointer items-center justify-center rounded-md bg-transparent text-ink-muted duration-120 ease-standard hover:bg-surface-overlay';

describe('iconButtonClass()', () => {
  test('quiet', () => {
    assert({
      given: 'the quiet tone',
      should: 'animate colors and switch to the full ink on hover',
      actual: iconButtonClass('quiet'),
      expected: `${base} transition-colors hover:text-ink`,
    });
  });

  test('reveal', () => {
    assert({
      given: 'the reveal tone inside a group row',
      should: 'start dimmed and turn accent and opaque while the row is hovered',
      actual: iconButtonClass('reveal'),
      expected: `${base} opacity-75 transition group-hover:text-accent group-hover:opacity-100`,
    });
  });
});
