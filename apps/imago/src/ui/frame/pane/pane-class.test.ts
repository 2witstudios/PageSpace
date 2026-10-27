import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { paneClass, paneControlClass, paneHeaderClass } from './pane-class';

describe('paneClass()', () => {
  test('a width token', () => {
    assert({
      given: 'a stage width token',
      should: 'never shrink, clip what it holds and move by width on the pane curve',
      actual: paneClass('w-list-pane'),
      expected: 'flex h-full flex-none overflow-clip pane-motion data-resizing:transition-none w-list-pane',
    });
  });

  test('closed', () => {
    assert({
      given: 'the closed width',
      should: 'keep the same base so the pane animates down to zero',
      actual: paneClass('w-0'),
      expected: 'flex h-full flex-none overflow-clip pane-motion data-resizing:transition-none w-0',
    });
  });

  test('the rest of the row', () => {
    assert({
      given: 'a middle area that takes the rest (grow)',
      should: 'flex to fill, shrink to nothing and clip, with no width motion of its own',
      actual: paneClass('grow'),
      expected: 'flex h-full min-w-0 flex-1 overflow-clip',
    });
  });
});

describe('paneHeaderClass', () => {
  test('the shared header', () => {
    assert({
      given: 'any pane header',
      should: 'be the 48px row with a hairline under it',
      actual: paneHeaderClass,
      expected: 'flex h-pane-header flex-none items-center gap-1 border-b border-hairline pr-2 pl-4 text-sm phone:h-phone-head phone:pr-1 phone:pl-4 phone:text-base',
    });
  });
});

describe('paneControlClass', () => {
  test('a borderless icon control', () => {
    assert({
      given: 'a head control such as close',
      should: 'be a borderless 28px ghost square that tints on hover',
      actual: paneControlClass,
      expected:
        'flex size-head-control flex-none cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-ink-muted no-underline hover:bg-fill hover:text-ink hover:no-underline phone:size-spine-tile-small phone:rounded-lg phone:text-ink',
    });
  });
});
