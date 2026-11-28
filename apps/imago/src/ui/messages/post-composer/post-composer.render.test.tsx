// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, press, typeInto, unmountAll } from '@/ui/test-support/dom';
import { postComposerFieldClass, postComposerSendClass } from './post-composer-class';
import { renderPostComposer } from './post-composer.render';

afterEach(unmountAll);

/** The composer over a real draft, recording every send. */
const Harness = ({ sends, initial = '', error = null }: { sends: string[]; initial?: string; error?: string | null }) => {
  const [draft, setDraft] = useState(initial);
  return renderPostComposer({
    draft,
    label: 'Message # launch',
    error,
    typeDraft: setDraft,
    send: () => sends.push(draft),
  });
};

const show = (props: { initial?: string; error?: string | null } = {}) => {
  const sends: string[] = [];
  const container = mount(<Harness sends={sends} {...props} />);
  const field = container.querySelector('textarea') as HTMLTextAreaElement;
  const button = container.querySelector('button[type="submit"]') as HTMLButtonElement;
  return { sends, container, field, button };
};

describe('renderPostComposer', () => {
  test('an empty composer', () => {
    const { field, button, sends } = show();
    click(button);
    assert({
      given: 'nothing typed',
      should: 'name the field for the channel, style it, and refuse to send',
      actual: [
        field.getAttribute('aria-label'),
        field.getAttribute('placeholder'),
        field.className,
        button.getAttribute('aria-label'),
        button.className,
        button.disabled,
        sends,
      ],
      expected: ['Message # launch', 'Message # launch', postComposerFieldClass, 'Send', postComposerSendClass, true, []],
    });
  });

  test('Enter sends, Shift+Enter breaks the line', () => {
    const { field, sends } = show();
    typeInto(field, 'hello');
    const shift = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
    field.dispatchEvent(shift);
    const prevented = press(field, 'Enter');
    assert({
      given: 'a typed post, then Shift+Enter and Enter',
      should: 'leave Shift+Enter to the field and send once on Enter',
      actual: [shift.defaultPrevented, prevented, sends],
      expected: [false, true, ['hello']],
    });
  });

  test('blank text and IME composition', () => {
    const { field, sends } = show();
    typeInto(field, '   \n ');
    press(field, 'Enter');
    typeInto(field, 'こんにちは');
    press(field, 'Enter', { keyCode: 229 });
    assert({
      given: 'only whitespace, then Enter confirming an IME composition',
      should: 'send neither',
      actual: sends,
      expected: [],
    });
  });

  test('the send button', () => {
    const { field, button, sends } = show();
    typeInto(field, 'via button');
    click(button);
    assert({
      given: 'a typed post and a click on Send',
      should: 'send it',
      actual: [button.disabled, sends],
      expected: [false, ['via button']],
    });
  });

  test('a failed send', () => {
    const { container } = show({ initial: 'hi', error: 'Could not send your post.' });
    assert({
      given: 'the last send failing',
      should: 'say so as an alert next to the field',
      actual: container.querySelector('[role="alert"]')?.textContent,
      expected: 'Could not send your post.',
    });
  });
});
