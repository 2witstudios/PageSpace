import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { cn } from './utils';

describe('cn() with imago type tokens', () => {
  test('text-chat is a font size, not a colour', () => {
    assert({
      given: 'text-chat followed by a text colour',
      should: 'keep both: a colour never strips the chat size',
      actual: [cn('text-chat', 'text-foreground'), cn('text-chat leading-relaxed', 'text-transparent')],
      expected: ['text-chat text-foreground', 'text-chat leading-relaxed text-transparent'],
    });
  });

  test('text-2xs is a font size, not a colour', () => {
    assert({
      given: 'text-2xs followed by a text colour',
      should: 'keep both',
      actual: cn('text-2xs', 'text-gray-500'),
      expected: 'text-2xs text-gray-500',
    });
  });

  test('the chat sizes still merge as sizes', () => {
    assert({
      given: 'a default size followed by text-chat, and text-chat followed by text-2xs',
      should: 'let the later size win, as for any other size',
      actual: [cn('text-sm', 'text-chat'), cn('text-chat', 'text-2xs')],
      expected: ['text-chat', 'text-2xs'],
    });
  });
});
