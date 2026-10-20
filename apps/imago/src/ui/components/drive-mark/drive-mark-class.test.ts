import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { MARK_COLORS } from '@pagespace/lib/avatars/avatar-core';
import { driveMarkClass, driveMarkImageClass, markFillClass } from './drive-mark-class';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '../../../app');
const appRoot = join(appDir, '..', '..');

const compile = async (classes: readonly string[]): Promise<string> => {
  const source = `${readFileSync(join(appDir, 'globals.css'), 'utf8')}\n@source inline("${classes.join(' ')}");`;
  const result = await postcss([tailwind({ base: appRoot }) as postcss.AcceptedPlugin]).process(source, {
    from: join(appDir, 'globals.primitives.css'),
  });
  return result.css;
};

const selectorOf = (cls: string): string => `.${cls.replace(/[:/.]/g, (char) => `\\${char}`)}`;

describe('drive mark classes', () => {
  test('a fill for every palette key', () => {
    assert({
      given: 'the mark palette',
      should: 'give every key its own fill',
      actual: MARK_COLORS.filter((color) => !markFillClass[color]),
      expected: [],
    });
  });

  test('every class resolves', async () => {
    const classes = [driveMarkClass, driveMarkImageClass, ...Object.values(markFillClass)]
      .flatMap((list) => list.split(' '))
      .filter((cls, index, all) => all.indexOf(cls) === index);
    const css = await compile(classes);
    assert({
      given: `the ${classes.length} classes the drive mark emits`,
      should: 'each generate a rule from the token-locked theme',
      actual: classes.filter((cls) => !css.includes(selectorOf(cls))),
      expected: [],
    });
  });
});
