import { renderToString } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { buttonClass } from './button-class';
import { renderButton } from './button.render';

describe('renderButton()', () => {
  test('defaults', () => {
    const html = renderToString(renderButton({ children: 'Register' }));
    assert({
      given: 'a button with only a label',
      should: 'render a non-submitting primary button around the label',
      actual: html,
      expected: `<button type="button" class="${buttonClass('primary')}">Register</button>`,
    });
  });

  test('variant and caller class', () => {
    const html = renderToString(
      renderButton({ variant: 'ghost', className: 'w-full', children: 'More' }),
    );
    assert({
      given: 'the ghost variant and a caller class',
      should: 'use the ghost classes and append the caller class',
      actual: html.includes(`class="${buttonClass('ghost')} w-full"`),
      expected: true,
    });
  });

  test('native attributes', () => {
    const html = renderToString(
      renderButton({ type: 'submit', disabled: true, children: 'Save' }),
    );
    assert({
      given: 'a disabled submit button',
      should: 'forward the native attributes',
      actual: [html.includes('type="submit"'), html.includes('disabled=""')],
      expected: [true, true],
    });
  });
});
