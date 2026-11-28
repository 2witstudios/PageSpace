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

describe('ChatTextarea type size', () => {
  const classesOf = (value: string) => {
    const view = mount(createElement(ChatTextarea, { value, onChange: () => {}, onSend: () => {}, placeholder: 'Ask anything…' }));
    const textarea = view.querySelector('textarea');
    const overlay = textarea?.parentElement?.querySelector(':scope > :not(textarea)[class*="px-3"]');
    return { textarea: textarea?.classList.contains('text-chat'), overlay: overlay?.classList.contains('text-chat') ?? null };
  };

  test('plain text', () => {
    assert({
      given: 'a draft with no mentions (text-foreground after the size)',
      should: 'keep the chat size on the field',
      actual: classesOf('Hello').textarea,
      expected: true,
    });
  });

  test('a draft with a mention', () => {
    assert({
      given: 'a mention, so the field turns text-transparent under the overlay',
      should: 'keep the chat size on both the field and the overlay, so the caret lines up',
      actual: classesOf('Ask @[Brief](p1:page) about it'),
      expected: { textarea: true, overlay: true },
    });
  });
});
