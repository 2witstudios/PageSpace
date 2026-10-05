import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { paneClass, paneControlClass, paneHeaderClass } from './pane-class';

describe('paneClass()', () => {
  test('a width token', () => {
    assert({
      given: 'a stage width token',
      should: 'never shrink, clip what it holds and move by width on the pane curve',
      actual: paneClass('w-list-pane'),
      expected: 'flex h-full flex-none overflow-clip pane-motion w-list-pane',
    });
  });

  test('closed', () => {
    assert({
      given: 'the closed width',
      should: 'keep the same base so the pane animates down to zero',
      actual: paneClass('w-0'),
      expected: 'flex h-full flex-none overflow-clip pane-motion w-0',
    });
  });
});

describe('paneHeaderClass', () => {
  test('the shared header', () => {
    assert({
      given: 'any pane header',
      should: 'be the 52px row with a hairline under it',
      actual: paneHeaderClass,
      expected: 'flex h-pane-header flex-none items-center gap-2 border-b border-hairline px-3',
    });
  });
});

describe('paneControlClass', () => {
  test('a borderless icon control', () => {
    assert({
      given: 'a header control such as close or the hamburger',
      should: 'be a borderless square that tints on hover',
      actual: paneControlClass,
      expected:
        'flex size-8 flex-none items-center justify-center rounded-md text-ink-muted hover:bg-surface-overlay hover:text-ink',
    });
  });
});
