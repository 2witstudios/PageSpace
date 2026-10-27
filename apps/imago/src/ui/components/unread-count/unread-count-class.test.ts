import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { unreadCountClass } from './unread-count-class';

describe('unreadCountClass', () => {
  test('the accent pill', () => {
    assert({
      given: 'the unread count',
      should:
        'be a 16px round accent pill with 10px medium figures in the accent ink',
      actual: unreadCountClass,
      expected:
        'flex h-unread min-w-unread flex-none items-center justify-center rounded-round bg-accent px-1 text-badge font-medium text-accent-ink tabular-nums',
    });
  });

  test('never red', () => {
    assert({
      given: 'the unread count',
      should: 'never use the red live color, which stays for errors',
      actual: /\b(bg|text)-live/.test(unreadCountClass),
      expected: false,
    });
  });
});
