import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { optionStates } from '../theme-switcher/theme-switcher-class';
import { textSizeOptionClass, textSizeSwitcherClass } from './text-size-switcher-class';

const base =
  'inline-flex h-8 flex-1 cursor-pointer items-center justify-center rounded-md border font-medium leading-tight transition-colors duration-120 ease-standard';

describe('text size switcher classes', () => {
  test('the pressed and unpressed options', () => {
    assert({
      given: 'a pressed and an unpressed option',
      should: 'look exactly like the theme switcher’s checked and unchecked options',
      actual: [textSizeOptionClass('default', true), textSizeOptionClass('default', false)],
      expected: [`${base} text-sm ${optionStates.checked}`, `${base} text-sm ${optionStates.unchecked}`],
    });
  });

  test('each glyph is larger than the last', () => {
    assert({
      given: 'small, default, large and larger',
      should: 'draw each "A" a type step above the one before',
      actual: (['small', 'default', 'large', 'larger'] as const).map((size) =>
        textSizeOptionClass(size, false).split(' ').find((name) => /^text-(xs|sm|md|lg)$/.test(name)),
      ),
      expected: ['text-xs', 'text-sm', 'text-md', 'text-lg'],
    });
  });

  test('every class resolves against the theme', async () => {
    const appDir = join(dirname(fileURLToPath(import.meta.url)), '../../../app');
    const lists = [
      textSizeSwitcherClass,
      ...(['small', 'default', 'large', 'larger'] as const).flatMap((size) => [
        textSizeOptionClass(size, true),
        textSizeOptionClass(size, false),
      ]),
    ];
    const classes = lists.flatMap((list) => list.split(' ')).filter((cls, index, all) => cls !== '' && all.indexOf(cls) === index);
    const source = `${readFileSync(join(appDir, 'globals.css'), 'utf8')}\n@source inline("${classes.join(' ')}");`;
    const { css } = await postcss([tailwind({ base: join(appDir, '..', '..') }) as postcss.AcceptedPlugin]).process(source, {
      from: join(appDir, 'globals.text-size-switcher.css'),
    });
    const selectorOf = (cls: string): string => `.${cls.replace(/[:/.[\]=]/g, (char) => `\\${char}`)}`;
    assert({
      given: `the ${classes.length} classes the text-size control emits`,
      should: 'each generate a rule from the token-locked theme',
      actual: classes.filter((cls) => !css.includes(selectorOf(cls))),
      expected: [],
    });
  });
});
