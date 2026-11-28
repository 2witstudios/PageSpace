// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';
import { ChatTextarea } from './ChatTextarea';

afterEach(unmountAll);

const label = (props: { placeholder: string; inputLabel?: string }) =>
  mount(createElement(ChatTextarea, { value: '', onChange: () => {}, onSend: () => {}, ...props }))
    .querySelector('textarea')
    ?.getAttribute('aria-label');

describe('ChatTextarea accessible name', () => {
  test('follows the placeholder unless a label is given', () => {
    assert({
      given: 'a classic placeholder, then Imago\'s contextual placeholder with a fixed label',
      should: 'name the field from the placeholder, then keep the fixed label',
      actual: [label({ placeholder: 'Message Imago...' }), label({ placeholder: 'Ask about Brief…', inputLabel: 'Message Imago' })],
      expected: ['Message Imago', 'Message Imago'],
    });
  });
});
