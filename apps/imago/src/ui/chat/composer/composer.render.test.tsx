// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, press, unmountAll } from '@/ui/test-support/dom';
import { composerEntryClass, composerFieldClass, composerSendClass } from './composer-class';
import { renderComposer, type ComposerRenderProps } from './composer.render';

afterEach(() => {
  unmountAll();
});

const setup = (overrides: Partial<ComposerRenderProps> = {}) => {
  const calls = { typed: [] as string[], sent: 0, stopped: 0 };
  const props: ComposerRenderProps = {
    draft: 'Summarise the roadmap',
    label: 'Message Imago',
    placeholder: 'Ask anything…',
    density: 'roomy',
    streaming: false,
    disabled: false,
    typeDraft: (draft) => calls.typed.push(draft),
    send: () => {
      calls.sent += 1;
    },
    stop: () => {
      calls.stopped += 1;
    },
    ...overrides,
  };
  const container = mount(renderComposer(props));
  const field = container.querySelector('textarea');
  if (!(field instanceof HTMLTextAreaElement)) throw new Error('no field');
  return { container, field, calls };
};

const button = (container: HTMLElement): HTMLButtonElement => {
  const element = container.querySelector('button');
  if (!(element instanceof HTMLButtonElement)) throw new Error('no button');
  return element;
};

describe('renderComposer()', () => {
  test('the floating card', () => {
    const { container, field } = setup();
    assert({
      given: 'the composer',
      should: 'float as the rounded-composer card with a labelled field holding the draft and a Send control',
      actual: [
        field.parentElement?.className,
        field.className,
        field.getAttribute('aria-label'),
        field.placeholder,
        field.value,
        [button(container).getAttribute('aria-label'), button(container).type, button(container).className],
      ],
      expected: [
        composerEntryClass,
        composerFieldClass('roomy'),
        'Message Imago',
        'Ask anything…',
        'Summarise the roadmap',
        ['Send', 'submit', composerSendClass],
      ],
    });
  });

  test('typing', () => {
    const { field, calls } = setup({ draft: '' });
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => {
      setValue?.call(field, 'Hello');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert({
      given: 'the viewer typing',
      should: 'hand every change to the shell state',
      actual: calls.typed,
      expected: ['Hello'],
    });
  });

  test('Enter sends', () => {
    const { field, calls } = setup();
    const cancelled = press(field, 'Enter');
    assert({
      given: 'Enter in the field',
      should: 'send, without inserting a newline',
      actual: [calls.sent, cancelled],
      expected: [1, true],
    });
  });

  test('Shift+Enter and composing', () => {
    const { field, calls } = setup();
    const shifted = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
    act(() => {
      field.dispatchEvent(shifted);
    });
    const composing = press(field, 'Enter', { keyCode: 229 });
    assert({
      given: 'Shift+Enter, and Enter confirming an IME composition',
      should: 'send neither, leaving the newline and the composition to the browser',
      actual: [calls.sent, shifted.defaultPrevented, composing],
      expected: [0, false, false],
    });
  });

  test('Send button', () => {
    const { container, calls } = setup();
    click(button(container));
    assert({
      given: 'a click on Send',
      should: 'send once',
      actual: calls.sent,
      expected: 1,
    });
  });

  test('nothing to send', () => {
    const blank = setup({ draft: '   ' });
    press(blank.field, 'Enter');
    const off = setup({ disabled: true });
    press(off.field, 'Enter');
    assert({
      given: 'a blank draft, and a composer with no agent to send to',
      should: 'disable Send and send nothing on Enter',
      actual: [button(blank.container).disabled, blank.calls.sent, button(off.container).disabled, off.calls.sent],
      expected: [true, 0, true, 0],
    });
  });

  test('stop while streaming', () => {
    const { container, field, calls } = setup({ streaming: true });
    const control = button(container);
    press(field, 'Enter');
    click(control);
    assert({
      given: 'a reply streaming',
      should: 'turn Send into Stop, which stops; Enter sends nothing meanwhile and the draft stays editable',
      actual: [control.getAttribute('aria-label'), control.type, calls.stopped, calls.sent, field.disabled],
      expected: ['Stop', 'button', 1, 0, false],
    });
  });

  test('dense', () => {
    const { field } = setup({ density: 'dense' });
    assert({
      given: 'the dense chat',
      should: 'use the dense field',
      actual: field.className,
      expected: composerFieldClass('dense'),
    });
  });
});
