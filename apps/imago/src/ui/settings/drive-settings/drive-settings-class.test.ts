import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import * as classes from './drive-settings-class';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '../../../app');
const appRoot = join(appDir, '..', '..');

/** The real globals.css compiled with exactly the given candidate classes. */
const compile = async (candidates: readonly string[]): Promise<string> => {
  const source = `${readFileSync(join(appDir, 'globals.css'), 'utf8')}\n@source inline("${candidates.join(' ')}");`;
  const result = await postcss([tailwind({ base: appRoot }) as postcss.AcceptedPlugin]).process(source, {
    from: join(appDir, 'globals.settings.css'),
  });
  return result.css;
};

const selectorOf = (cls: string): string => `.${cls.replace(/[:/.]/g, (char) => `\\${char}`)}`;

describe('settings classes', () => {
  test('the switch', () => {
    assert({
      given: 'the Imago access switch on and off',
      should: 'fill the track with the accent and slide the knob only when on',
      actual: [
        classes.switchClass(true),
        classes.switchClass(false),
        classes.switchKnobClass(true),
        classes.switchKnobClass(false),
      ],
      expected: [
        'inline-flex h-6 w-10 flex-none cursor-pointer items-center rounded-round px-1 transition-colors duration-120 ease-standard disabled:cursor-default disabled:opacity-60 bg-accent',
        'inline-flex h-6 w-10 flex-none cursor-pointer items-center rounded-round px-1 transition-colors duration-120 ease-standard disabled:cursor-default disabled:opacity-60 bg-border-strong',
        'size-4 rounded-round bg-background shadow-ambient transition-transform duration-120 ease-standard translate-x-4',
        'size-4 rounded-round bg-background shadow-ambient transition-transform duration-120 ease-standard translate-x-0',
      ],
    });
  });

  test('the notice', () => {
    assert({
      given: 'a refused change',
      should: 'read in the live color, small and medium',
      actual: classes.settingsNoticeClass,
      expected: 'm-0 text-xs font-medium text-live',
    });
  });

  test('every class resolves', async () => {
    const all = Object.values(classes)
      .flatMap((value) => (typeof value === 'function' ? [value(true), value(false)] : [value]))
      .flatMap((list) => list.split(' '))
      .filter((cls, index, list) => list.indexOf(cls) === index);
    const css = await compile(all);
    assert({
      given: `the ${all.length} classes the settings module emits`,
      should: 'each generate a rule from the token-locked theme',
      actual: all.filter((cls) => !css.includes(selectorOf(cls))),
      expected: [],
    });
  });
});
