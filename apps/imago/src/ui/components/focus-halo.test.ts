import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss, { type Root } from 'postcss';
import { afterAll, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { checkboxClass } from './checkbox/checkbox-class';
import { inlineAddFieldClass, inlineAddRestClass } from './inline-add/inline-add-class';
import { searchInputClass } from './search-input/search-input-class';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app');
const stylesheet = join(appDir, 'globals.css');

/**
 * The class strings on the elements that take focus. The search field's
 * <label> is not one: its glass shadow sits on the wrapper, and the halo is
 * drawn on the input inside it.
 */
const focusableClasses = [
  checkboxClass(true),
  checkboxClass(false),
  searchInputClass,
  inlineAddRestClass,
  inlineAddFieldClass,
];

// An empty base for Tailwind's automatic source scan, so the compiled CSS
// holds only the candidates each test passes, not every class on disk.
const emptyBase = mkdtempSync(join(tmpdir(), 'imago-focus-halo-'));

afterAll(() => rmSync(emptyBase, { recursive: true, force: true }));

/** Compiles the real globals.css with exactly the given classes as candidates. */
const compile = async (classes: readonly string[], name: string): Promise<Root> => {
  const source = `${readFileSync(stylesheet, 'utf8')}\n@source inline("${classes.join(' ')}");`;
  const result = await postcss([tailwind({ base: emptyBase }) as postcss.AcceptedPlugin]).process(
    source,
    { from: join(appDir, `globals.focus-halo-${name}.css`) },
  );
  return postcss.parse(result.css);
};

/** Selectors of utility rules that set box-shadow or a Tailwind shadow/ring variable. */
const haloOverrides = (css: Root): string[] => {
  const selectors = new Set<string>();
  css.walkAtRules('layer', (layer) => {
    if (layer.params !== 'utilities') return;
    layer.walkDecls(/^(box-shadow|--tw-shadow|--tw-ring-shadow|--tw-inset-shadow)$/, (decl) => {
      const parent = decl.parent;
      if (parent && 'selector' in parent) selectors.add(String(parent.selector));
    });
  });
  return [...selectors];
};

describe('form primitives: focus halo', () => {
  test('the halo every focusable primitive inherits', async () => {
    const css = await compile(focusableClasses, 'base');
    const focus: Record<string, string> = {};
    css.walkRules(':focus-visible', (rule) =>
      rule.walkDecls((decl) => {
        focus[decl.prop] = decl.value;
      }),
    );
    const ring: Record<string, string> = {};
    css.walkRules(':root', (rule) =>
      rule.walkDecls(/^--(focus|accent)-ring$/, (decl) => {
        ring[decl.prop] = decl.value.replace(/\s+/g, ' ');
      }),
    );
    assert({
      given: 'the compiled stylesheet',
      should: 'draw focus as a 3px halo in the accent, not an outline',
      actual: { focus, ring },
      expected: {
        focus: {
          outline: 'none',
          'box-shadow': 'var(--focus-ring)',
          'border-radius': 'var(--radius-sm)',
        },
        ring: {
          '--accent-ring': 'light-dark( oklch(0.5 0.16 235 / 0.5), oklch(0.62 0.16 235 / 0.5) )',
          '--focus-ring': '0 0 0 3px var(--accent-ring)',
        },
      },
    });
  });

  test('no primitive overrides the halo', async () => {
    assert({
      given: 'every class on the focusable elements of Checkbox, SearchInput and InlineAdd',
      should: 'generate no utility that replaces the focus box-shadow',
      actual: haloOverrides(await compile(focusableClasses, 'primitives')),
      expected: [],
    });
  });

  test('negative control', async () => {
    assert({
      given: 'a class that would replace the halo on focus',
      should: 'be caught by the override check',
      actual: haloOverrides(await compile([...focusableClasses, 'focus-visible:shadow-1'], 'control')),
      expected: ['&:focus-visible'],
    });
  });
});
