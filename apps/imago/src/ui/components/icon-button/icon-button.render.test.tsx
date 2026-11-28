import { renderToString } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { renderIcon } from '../icon/icon.render';
import { iconButtonClass } from './icon-button-class';
import { renderIconButton } from './icon-button.render';

describe('renderIconButton()', () => {
  test('defaults', () => {
    const html = renderToString(
      renderIconButton({ name: 'menu', label: 'Open menu' }),
    );
    assert({
      given: 'an icon-only button with a label',
      should:
        'render a quiet, non-submitting button named by the label around a decorative 16px icon',
      actual: html,
      expected: `<button type="button" aria-label="Open menu" title="Open menu" class="${iconButtonClass('quiet')}">${renderToString(renderIcon({ name: 'menu' }))}</button>`,
    });
  });

  test('tone, caller class and native attributes', () => {
    const html = renderToString(
      renderIconButton({
        name: 'trash',
        label: 'Delete',
        tone: 'reveal',
        className: 'ml-auto',
        disabled: true,
      }),
    );
    assert({
      given: 'a disabled reveal-tone icon button with a caller class',
      should: 'use the reveal classes, append the caller class and stay disabled',
      actual: [
        html.includes(`class="${iconButtonClass('reveal')} ml-auto"`),
        html.includes('disabled=""'),
        html.includes('lucide-trash2'),
      ],
      expected: [true, true, true],
    });
  });
});
