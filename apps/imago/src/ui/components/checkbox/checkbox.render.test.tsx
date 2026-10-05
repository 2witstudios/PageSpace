import { renderToString } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { findElement } from '../../test-support/find-element';
import { checkboxClass } from './checkbox-class';
import { renderCheckbox } from './checkbox.render';

const html = (checked: boolean) =>
  renderToString(renderCheckbox({ checked, label: 'Done', toggle: () => undefined }));

describe('renderCheckbox', () => {
  test('role, name and state', () => {
    assert({
      given: 'a ticked and an open checkbox',
      should: 'render a native button with the checkbox role, its name and its state',
      actual: [
        html(true).startsWith('<button type="button" role="checkbox"'),
        html(true).includes('aria-checked="true"'),
        html(false).includes('aria-checked="false"'),
        html(false).includes('aria-label="Done"'),
      ],
      expected: [true, true, true, true],
    });
  });

  test('keyboard reach', () => {
    assert({
      given: 'the rendered checkbox',
      should: 'stay in the tab order (no tabindex) and keep its check glyph out of the name',
      actual: [html(true).includes('tabindex'), html(true).includes('aria-hidden="true"')],
      expected: [false, true],
    });
  });

  test('styling', () => {
    assert({
      given: 'each state',
      should: 'use the class module for that state',
      actual: [
        html(true).includes(`class="${checkboxClass(true)}"`),
        html(false).includes(`class="${checkboxClass(false)}"`),
      ],
      expected: [true, true],
    });
  });

  test('activation', () => {
    const toggles: string[] = [];
    const button = findElement<{ onClick?: () => void }>(
      renderCheckbox({ checked: false, label: 'Done', toggle: () => toggles.push('toggle') }),
      (element) => element.type === 'button',
    );
    button?.props.onClick?.();
    assert({
      given: 'a click (or Space/Enter, which a native button turns into a click)',
      should: 'call toggle once',
      actual: toggles,
      expected: ['toggle'],
    });
  });
});
