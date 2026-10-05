import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { badgeClass, badgeTones } from './badge/badge-class';
import { buttonClass } from './button/button-class';
import { iconButtonClass } from './icon-button/icon-button-class';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '../../app');
const appRoot = join(appDir, '..', '..');

/** The real globals.css compiled with exactly the given candidate classes. */
const compile = async (classes: readonly string[]): Promise<string> => {
  const source = `${readFileSync(join(appDir, 'globals.css'), 'utf8')}\n@source inline("${classes.join(' ')}");`;
  const result = await postcss([
    tailwind({ base: appRoot }) as postcss.AcceptedPlugin,
  ]).process(source, { from: join(appDir, 'globals.primitives.css') });
  return result.css;
};

const selectorOf = (cls: string): string =>
  `.${cls.replace(/[:/.]/g, (char) => `\\${char}`)}`;

const moduleClasses = [
  ...(['primary', 'secondary', 'ghost'] as const).map(buttonClass),
  ...(['quiet', 'reveal'] as const).map(iconButtonClass),
  ...badgeTones.map(badgeClass),
]
  .flatMap((list) => list.split(' '))
  .filter((cls, index, all) => all.indexOf(cls) === index);

describe('primitive class modules against the theme', () => {
  test('every class resolves', async () => {
    const css = await compile(moduleClasses);
    assert({
      given: `the ${moduleClasses.length} classes the button, icon-button and badge modules emit`,
      should: 'each generate a rule from the token-locked theme',
      actual: moduleClasses.filter((cls) => !css.includes(selectorOf(cls))),
      expected: [],
    });
  });

  test('control sizes', async () => {
    const css = await compile(['h-control', 'size-8']);
    assert({
      given: 'the button height and the icon-button square',
      should: 'be 36px and 32px',
      actual: [
        /--spacing-control: 36px/.test(css) && /\.h-control \{\s*height: var\(--spacing-control\)/.test(css),
        /--spacing-8: 32px/.test(css) && /\.size-8 \{\s*width: var\(--spacing-8\);\s*height: var\(--spacing-8\)/.test(css),
      ],
      expected: [true, true],
    });
  });
});
