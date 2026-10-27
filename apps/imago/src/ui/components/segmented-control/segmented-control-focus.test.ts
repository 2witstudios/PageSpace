import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss, { type Root } from 'postcss';
import { afterAll, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { segmentClass } from './segmented-control-class';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'app');

// An empty base for Tailwind's source scan, so the compiled CSS holds only
// the candidates each test passes.
const emptyBase = mkdtempSync(join(tmpdir(), 'imago-segment-focus-'));

afterAll(() => rmSync(emptyBase, { recursive: true, force: true }));

/** Compiles the real globals.css with exactly the given classes as candidates. */
const compile = async (classes: string, name: string): Promise<Root> => {
  const source = `${readFileSync(join(appDir, 'globals.css'), 'utf8')}\n@source inline("${classes}");`;
  const result = await postcss([tailwind({ base: emptyBase }) as postcss.AcceptedPlugin]).process(
    source,
    { from: join(appDir, `globals.segment-focus-${name}.css`) },
  );
  return postcss.parse(result.css);
};

/** The shadow a focused element ends with: the last focus-visible utility's --tw-shadow. */
const focusedShadow = (css: Root): string | undefined => {
  let shadow: string | undefined;
  css.walkAtRules('layer', (layer) => {
    if (layer.params !== 'utilities') return;
    layer.walkRules('&:focus-visible', (rule) =>
      rule.walkDecls('--tw-shadow', (decl) => {
        shadow = decl.value;
      }),
    );
  });
  return shadow;
};

describe('segmentClass: focus halo', () => {
  test('the checked segment keeps the halo', async () => {
    assert({
      given: 'the checked segment, lifted by the ambient shadow',
      should: 'draw the global 3px accent halo while focused instead of the lift',
      actual: focusedShadow(await compile(segmentClass(true), 'checked')),
      expected: 'var(--focus-ring)',
    });
  });

  test('negative control', async () => {
    assert({
      given: 'the checked segment without its focus override',
      should: 'leave nothing to restore the halo the lift replaces',
      actual: focusedShadow(
        await compile(segmentClass(true).replace(' focus-visible:shadow-focus', ''), 'control'),
      ),
      expected: undefined,
    });
  });
});
