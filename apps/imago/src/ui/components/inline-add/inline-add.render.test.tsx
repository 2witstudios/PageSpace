import { renderToString } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { findElement } from '../../test-support/find-element';
import { inlineAddFieldClass, inlineAddRestClass } from './inline-add-class';
import { renderInlineAdd, type InlineAddRenderProps } from './inline-add.render';

type KeyEvent = {
  readonly key: string;
  readonly nativeEvent: { readonly isComposing: boolean };
  readonly preventDefault: () => void;
};

type Handlers = {
  readonly onClick?: () => void;
  readonly onChange?: (event: { readonly currentTarget: { readonly value: string } }) => void;
  readonly onKeyDown?: (event: KeyEvent) => void;
  readonly onBlur?: () => void;
};

/** Renders with every action recording its name (and argument) in `calls`. */
const withCalls = (overrides: Partial<InlineAddRenderProps>) => {
  const calls: string[] = [];
  const rendered = renderInlineAdd({
    open: false,
    draft: '',
    label: 'Add subtask',
    placeholder: 'Subtask title',
    startAdding: () => calls.push('startAdding'),
    typeDraft: (draft) => calls.push(`typeDraft:${draft}`),
    commitDraft: () => calls.push('commitDraft'),
    cancelAdding: () => calls.push('cancelAdding'),
    leaveField: () => calls.push('leaveField'),
    ...overrides,
  });
  return { calls, rendered };
};

const pressKey = (key: string, isComposing = false) => {
  const { calls, rendered } = withCalls({ open: true, draft: 'Write tests' });
  let prevented = false;
  findElement<Handlers>(rendered, (element) => element.type === 'input')?.props.onKeyDown?.({
    key,
    nativeEvent: { isComposing },
    preventDefault: () => {
      prevented = true;
    },
  });
  return { calls, prevented };
};

describe('renderInlineAdd', () => {
  test('resting', () => {
    const { calls, rendered } = withCalls({ open: false });
    const html = renderToString(rendered);
    findElement<Handlers>(rendered, (element) => element.type === 'button')?.props.onClick?.();
    assert({
      given: 'the closed control',
      should: 'be a native button named for what it adds, with no field yet, that opens on activation',
      actual: [
        html.startsWith(`<button type="button" class="${inlineAddRestClass}">`),
        html.includes('Add subtask'),
        html.includes('aria-hidden="true"'),
        html.includes('<input'),
        calls,
      ],
      expected: [true, true, true, false, ['startAdding']],
    });
  });

  test('open', () => {
    const { calls, rendered } = withCalls({ open: true, draft: 'Write' });
    const html = renderToString(rendered);
    const input = findElement<Handlers>(rendered, (element) => element.type === 'input');
    input?.props.onChange?.({ currentTarget: { value: 'Write tests' } });
    input?.props.onBlur?.();
    assert({
      given: 'the open field',
      should: 'render a named, controlled text field that reports typing and leaving',
      actual: [
        html.includes('<button'),
        html.includes('value="Write"'),
        html.includes('aria-label="Add subtask"'),
        html.includes('placeholder="Subtask title"'),
        html.includes(`class="${inlineAddFieldClass}"`),
        calls,
      ],
      expected: [false, true, true, true, true, ['typeDraft:Write tests', 'leaveField']],
    });
  });

  test('Enter', () => {
    assert({
      given: 'Enter in the field',
      should: 'commit the draft and keep the key from submitting a form',
      actual: pressKey('Enter'),
      expected: { calls: ['commitDraft'], prevented: true },
    });
  });

  test('Enter while composing', () => {
    assert({
      given: 'Enter that confirms an IME composition',
      should: 'leave it to the input method',
      actual: pressKey('Enter', true),
      expected: { calls: [], prevented: false },
    });
  });

  test('Escape', () => {
    assert({
      given: 'Escape in the field',
      should: 'cancel adding and keep the key from closing anything else',
      actual: pressKey('Escape'),
      expected: { calls: ['cancelAdding'], prevented: true },
    });
  });

  test('other keys', () => {
    assert({
      given: 'any other key',
      should: 'do nothing beyond typing',
      actual: pressKey('a'),
      expected: { calls: [], prevented: false },
    });
  });
});
