import { renderToString } from 'react-dom/server';
import { Children, isValidElement, type ReactNode } from 'react';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { renderTextSizeSwitcher } from './text-size-switcher.render';
import type { TextSize } from '@/lib/text-size/text-size-preference';

type ButtonProps = { readonly children?: ReactNode; readonly type?: string; readonly onClick?: () => void };

const buttonsOf = (node: ReactNode): readonly ButtonProps[] => {
  if (!isValidElement<ButtonProps>(node)) return [];
  if (node.type === 'button') return [node.props];
  return Children.toArray(node.props.children).flatMap(buttonsOf);
};

/** Each rendered button's accessible name, pressed state and visible text. */
const buttonsIn = (html: string) =>
  [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attributes = '', inner = '']) => ({
    label: /aria-label="([^"]*)"/.exec(attributes)?.[1],
    pressed: /aria-pressed="([^"]*)"/.exec(attributes)?.[1],
    text: inner.replace(/<[^>]*>/g, ''),
  }));

const render = (size: TextSize) => renderToString(renderTextSizeSwitcher({ size, selectSize: () => {} }));

describe('renderTextSizeSwitcher', () => {
  test('a labelled row of four sizes with the current one pressed', () => {
    const html = render('large');

    assert({
      given: 'the large size',
      should: 'offer Small, Default, Large and Larger as "A" buttons, Large pressed',
      actual: { group: html.includes('role="group" aria-label="Text size"'), buttons: buttonsIn(html) },
      expected: {
        group: true,
        buttons: [
          { label: 'Text size: Small', pressed: 'false', text: 'A' },
          { label: 'Text size: Default', pressed: 'false', text: 'A' },
          { label: 'Text size: Large', pressed: 'true', text: 'A' },
          { label: 'Text size: Larger', pressed: 'false', text: 'A' },
        ],
      },
    });
  });

  test('each size presses only its own button', () => {
    assert({
      given: 'each size',
      should: 'press exactly that button',
      actual: (['small', 'default', 'large', 'larger'] as const).map((size) =>
        buttonsIn(render(size))
          .filter((button) => button.pressed === 'true')
          .map((button) => button.label),
      ),
      expected: [['Text size: Small'], ['Text size: Default'], ['Text size: Large'], ['Text size: Larger']],
    });
  });

  test('no caption or helper text', () => {
    assert({
      given: 'the rendered control',
      should: 'show nothing but the four glyphs',
      actual: render('default').replace(/<[^>]*>/g, ''),
      expected: 'AAAA',
    });
  });

  test('a click selects that size', () => {
    const chosen: TextSize[] = [];
    for (const button of buttonsOf(renderTextSizeSwitcher({ size: 'default', selectSize: (size) => chosen.push(size) }))) {
      button.onClick?.();
    }

    assert({
      given: 'a click on each button',
      should: 'select each size in order',
      actual: chosen,
      expected: ['small', 'default', 'large', 'larger'],
    });
  });
});
