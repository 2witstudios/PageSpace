import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';

const cwd = dirname(dirname(fileURLToPath(import.meta.url)));
const eslint = new ESLint({ cwd, overrideConfigFile: 'eslint.config.mjs' });

const tailwindRules = async (code: string, filePath: string) => {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages
    .map(({ ruleId }) => ruleId)
    .filter((ruleId) => ruleId?.startsWith('better-tailwindcss/'));
};

const lintMarkup = (classes: string) =>
  tailwindRules(
    `export const Probe = () => <div className="${classes}" />;\n`,
    'src/ui/probe.tsx',
  );

// Token-locked Tailwind lint rules (ADR 0028 in myimago, ported for IMG-2.1).
// Every test is a negative control for one rule except the first.
describe('apps/imago ESLint: token-locked Tailwind', () => {
  test('registered token classes', async () => {
    assert({
      given: 'classes that all come from the imago theme',
      should: 'report nothing',
      actual: await lintMarkup('bg-surface p-4 text-ink-muted max-rail:p-2'),
      expected: [],
    });
  });

  test('arbitrary values and properties', async () => {
    assert({
      given: 'an arbitrary value and an arbitrary property',
      should: 'report the restricted-class rule for both',
      actual: await lintMarkup('w-[10px] [mask-type:luminance]'),
      expected: [
        'better-tailwindcss/no-restricted-classes',
        'better-tailwindcss/no-restricted-classes',
      ],
    });
  });

  test('default-theme classes the reset removed', async () => {
    assert({
      given: 'bg-red-500 and p-7, which Tailwind ships but imago does not',
      should: 'report both as unknown',
      actual: await lintMarkup('bg-red-500 p-7'),
      expected: [
        'better-tailwindcss/no-unknown-classes',
        'better-tailwindcss/no-unknown-classes',
      ],
    });
  });

  test('conflicting classes', async () => {
    assert({
      given: 'two padding utilities on one element',
      should: 'report the conflict on each',
      actual: await lintMarkup('p-2 p-4'),
      expected: [
        'better-tailwindcss/no-conflicting-classes',
        'better-tailwindcss/no-conflicting-classes',
      ],
    });
  });

  test('duplicate classes', async () => {
    assert({
      given: 'the same class twice',
      should: 'report a duplicate',
      actual: await lintMarkup('p-4 flex p-4'),
      expected: ['better-tailwindcss/no-duplicate-classes'],
    });
  });

  test('per-element dark and color-scheme variants', async () => {
    assert({
      given:
        'a dark: variant, a negated not-dark: variant and a color-scheme utility',
      should: 'report the restricted-class rule for each',
      actual: await lintMarkup(
        'dark:bg-surface not-dark:bg-surface-raised scheme-dark',
      ),
      expected: [
        'better-tailwindcss/no-restricted-classes',
        'better-tailwindcss/no-restricted-classes',
        'better-tailwindcss/no-restricted-classes',
      ],
    });
  });

  test('variant class modules', async () => {
    assert({
      given:
        'an arbitrary value, a misspelled token and a dark: variant held in a *-class.ts module',
      should: 'report each one, whatever the variable is named',
      actual: await tailwindRules(
        [
          "const base = 'w-[10px] flex';",
          "const tones = { quiet: 'bg-surfce', loud: 'dark:bg-surface' } as const;",
          'export const probeClass = (tone: keyof typeof tones): string =>',
          '  `${base} ${tones[tone]}`;',
          '',
        ].join('\n'),
        'src/ui/components/probe/probe-class.ts',
      ),
      expected: [
        'better-tailwindcss/no-restricted-classes',
        'better-tailwindcss/no-unknown-classes',
        'better-tailwindcss/no-restricted-classes',
      ],
    });
  });
});
