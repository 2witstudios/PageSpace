import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss, { type AtRule, type Root, type Rule } from 'postcss';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';

const appDir = dirname(fileURLToPath(import.meta.url));
const stylesheet = join(appDir, 'globals.css');
const themeFiles = [
  stylesheet,
  join(appDir, 'theme/reset.css'),
  join(appDir, 'theme/frame.css'),
  join(appDir, 'theme/components.css'),
];
const tailwindTheme = join(
  dirname(createRequire(import.meta.url).resolve('tailwindcss')),
  '..',
  'theme.css',
);

/** Compiles the real globals.css with exactly the given candidate classes. */
const compile = async (classes: string[]): Promise<Root> => {
  const source = `${readFileSync(stylesheet, 'utf8')}\n@source inline("${classes.join(' ')}");`;
  const result = await postcss([tailwind() as postcss.AcceptedPlugin]).process(
    source,
    { from: stylesheet },
  );
  return postcss.parse(result.css);
};

/** Every token a file declares inside `@theme` / `@theme inline`, resets excluded. */
const themeTokens = (file: string): Map<string, string> => {
  const tokens = new Map<string, string>();
  postcss.parse(readFileSync(file, 'utf8')).walkAtRules('theme', (block) => {
    block.walkDecls(/^--/, (decl) => {
      if (decl.value !== 'initial') tokens.set(decl.prop, decl.value);
    });
  });
  return tokens;
};

const imagoTokens = new Map(themeFiles.flatMap((file) => [...themeTokens(file)]));

/** Tailwind's own default token names (`--default-*` are not utility namespaces). */
const defaultTokenNames = [...themeTokens(tailwindTheme).keys()].filter(
  (name) => !name.startsWith('--default-'),
);

/**
 * Default names imago deliberately keeps for its own scale: the type steps,
 * the radius ladder, the four weights, two leadings, three trackings and the
 * mono stack. Adding a name here is the only way a default name comes back.
 */
const ADOPTED_DEFAULT_NAMES = [
  '--font-mono',
  '--font-weight-bold',
  '--font-weight-medium',
  '--font-weight-normal',
  '--font-weight-semibold',
  '--leading-normal',
  '--leading-tight',
  '--radius-lg',
  '--radius-md',
  '--radius-sm',
  '--radius-xl',
  '--text-2xl',
  '--text-3xl',
  '--text-base',
  '--text-lg',
  '--text-sm',
  '--text-xl',
  '--text-xs',
  '--tracking-tight',
  '--tracking-tighter',
  '--tracking-wide',
];

/** The utility a default token would generate, if its namespace were live. */
const utilityFor = (name: string): string | undefined => {
  const prefixes: [RegExp, (rest: string) => string][] = [
    [/^--color-(.+)$/, (rest) => `bg-${rest}`],
    [/^--breakpoint-(.+)$/, (rest) => `${rest}:flex`],
    [/^--container-(.+)$/, (rest) => `max-w-${rest}`],
    [/^--max-width-(.+)$/, (rest) => `max-w-${rest}`],
    [/^--font-weight-(.+)$/, (rest) => `font-${rest}`],
    [/^--font-(.+)$/, (rest) => `font-${rest}`],
    [/^--tracking-(.+)$/, (rest) => `tracking-${rest}`],
    [/^--leading-(.+)$/, (rest) => `leading-${rest}`],
    [/^--radius-(.+)$/, (rest) => `rounded-${rest}`],
    [/^--inset-shadow-(.+)$/, (rest) => `inset-shadow-${rest}`],
    [/^--drop-shadow-(.+)$/, (rest) => `drop-shadow-${rest}`],
    [/^--text-shadow-(.+)$/, (rest) => `text-shadow-${rest}`],
    [/^--shadow-(.+)$/, (rest) => `shadow-${rest}`],
    [/^--text-([a-z0-9]+)$/, (rest) => `text-${rest}`],
    [/^--blur-(.+)$/, (rest) => `blur-${rest}`],
    [/^--ease-(.+)$/, (rest) => `ease-${rest}`],
    [/^--animate-(.+)$/, (rest) => `animate-${rest}`],
    [/^--perspective-(.+)$/, (rest) => `perspective-${rest}`],
    [/^--aspect-(.+)$/, (rest) => `aspect-${rest}`],
  ];
  for (const [pattern, toUtility] of prefixes) {
    const match = name.match(pattern);
    if (match) return toUtility(match[1]);
  }
  return undefined;
};

/** Class selectors present in compiled CSS, unescaped (`sm\:flex` → `sm:flex`). */
const emittedClasses = (css: Root): Set<string> => {
  const classes = new Set<string>();
  css.walkRules((rule) => {
    for (const match of rule.selector.matchAll(/\.((?:\\.|[\w-])+)/g)) {
      classes.add(match[1].replace(/\\/g, ''));
    }
  });
  return classes;
};

const declsOf = (css: Root, selector: string): Record<string, string> => {
  const decls: Record<string, string> = {};
  css.walkRules((rule: Rule) => {
    if (rule.selector.replace(/"/g, "'") !== selector) return;
    rule.walkDecls((decl) => {
      decls[decl.prop] = `${decl.value}${decl.important ? ' !important' : ''}`;
    });
  });
  return decls;
};

describe('imago Tailwind theme (token lock)', () => {
  test('a numbered or default token name reappearing', () => {
    assert({
      given: 'every token the imago stylesheets declare',
      should:
        'share no name with the Tailwind default theme beyond the adopted scale',
      actual: [...imagoTokens.keys()]
        .filter((name) => defaultTokenNames.includes(name))
        .sort(),
      expected: ADOPTED_DEFAULT_NAMES,
    });
  });

  test('default-theme utilities after the reset', async () => {
    const candidates = defaultTokenNames
      .filter((name) => !ADOPTED_DEFAULT_NAMES.includes(name))
      .map(utilityFor)
      .filter((utility): utility is string => utility !== undefined);
    const samples = ['p-7', 'w-13', 'gap-2.5', 'rounded', 'shadow', 'blur'];
    const emitted = emittedClasses(await compile([...candidates, ...samples]));

    assert({
      given: `${candidates.length} default-theme utilities imago does not define`,
      should: 'emit no rule for any of them',
      actual: [...candidates, ...samples].filter((utility) =>
        emitted.has(utility),
      ),
      expected: [],
    });
  });

  test('token utilities', async () => {
    const css = await compile([
      'bg-surface',
      'p-4',
      'text-ink-muted',
      'shadow-2',
      'rounded-composer',
      'w-rail-width',
    ]);

    assert({
      given: 'utilities named after imago tokens',
      should: 'resolve through var() so a theme switch needs no class change',
      actual: [
        declsOf(css, '.bg-surface')['background-color'],
        declsOf(css, '.p-4').padding,
        declsOf(css, '.text-ink-muted').color,
        declsOf(css, '.shadow-2')['--tw-shadow'],
        declsOf(css, '.rounded-composer')['border-radius'],
        declsOf(css, '.w-rail-width').width,
      ],
      expected: [
        'var(--surface)',
        'var(--spacing-4)',
        'var(--text-muted)',
        'var(--elevation-2)',
        'var(--radius-composer)',
        'var(--spacing-rail-width)',
      ],
    });
  });
});

describe('imago design tokens', () => {
  const root = (() => {
    const decls: Record<string, string> = {};
    postcss
      .parse(readFileSync(stylesheet, 'utf8'))
      .walkRules(':root', (rule) =>
        rule.walkDecls(/^--/, (decl) => {
          decls[decl.prop] = decl.value.replace(/\s+/g, ' ');
        }),
      );
    return decls;
  })();

  test('color tokens', () => {
    assert({
      given: 'the :root custom properties',
      should: 'write every color once as a light-dark() pair',
      actual: Object.entries(root)
        .filter(([, value]) => !value.includes('light-dark('))
        .map(([name]) => name),
      expected: ['--focus-ring'],
    });

    assert({
      given: 'the neutrals and the accent',
      should: "use PageSpace's ramp and its blue --primary",
      actual: [root['--background'], root['--surface'], root['--accent']],
      expected: [
        'light-dark(oklch(0.995 0.002 240), oklch(0.17 0 0))',
        'light-dark(oklch(0.98 0.003 230), oklch(0.2 0 0))',
        'light-dark(oklch(0.5 0.16 235), oklch(0.62 0.16 235))',
      ],
    });

    assert({
      given: 'the glass materials and the hairline',
      should: 'define each as a light-dark() token',
      actual: [
        '--glass-pane',
        '--glass-object',
        '--glass-raised',
        '--glass-sheen',
        '--hairline',
      ].filter((name) => !root[name]?.startsWith('light-dark(')),
      expected: [],
    });
  });

  test('shape, type, frame and motion tokens', () => {
    const pick = (names: string[]) =>
      names.map((name) => [name, imagoTokens.get(name)]);

    assert({
      given: 'the radius ladder',
      should: 'be 6 / 8 / 10 / 14 with only the composer rounder at 16',
      actual: pick([
        '--radius-sm',
        '--radius-md',
        '--radius-lg',
        '--radius-xl',
        '--radius-composer',
      ]),
      expected: [
        ['--radius-sm', '6px'],
        ['--radius-md', '8px'],
        ['--radius-lg', '10px'],
        ['--radius-xl', '14px'],
        ['--radius-composer', '16px'],
      ],
    });

    assert({
      given: 'the type scale',
      should: 'set 14px body type and exactly four weights',
      actual: [
        imagoTokens.get('--text-base'),
        [...imagoTokens.keys()].filter((name) =>
          name.startsWith('--font-weight-'),
        ),
        pick(['--font-weight-normal', '--font-weight-bold']),
      ],
      expected: [
        '0.875rem',
        [
          '--font-weight-normal',
          '--font-weight-medium',
          '--font-weight-semibold',
          '--font-weight-bold',
        ],
        [
          ['--font-weight-normal', '400'],
          ['--font-weight-bold', '700'],
        ],
      ],
    });

    assert({
      given: 'the frame spacing',
      should: 'name the rail, pane header, list, tree and chat widths',
      actual: pick([
        '--spacing-rail-width',
        '--spacing-pane-header',
        '--spacing-list-pane',
        '--spacing-tree-pane',
        '--spacing-chat-pane',
      ]),
      expected: [
        ['--spacing-rail-width', '64px'],
        ['--spacing-pane-header', '52px'],
        ['--spacing-list-pane', '274px'],
        ['--spacing-tree-pane', '244px'],
        ['--spacing-chat-pane', '350px'],
      ],
    });
  });

  test('pane motion', async () => {
    const css = await compile(['pane-motion']);

    assert({
      given: 'the pane-motion utility',
      should: 'move width over 320ms on --ease-pane',
      actual: [imagoTokens.get('--ease-pane'), declsOf(css, '.pane-motion')],
      expected: [
        'cubic-bezier(0.2, 0.8, 0.3, 1)',
        {
          'transition-property': 'width',
          'transition-duration': '320ms',
          'transition-timing-function': 'var(--ease-pane)',
        },
      ],
    });
  });
});

describe('imago theme selection and motion', () => {
  test('color-scheme per theme', async () => {
    const css = await compile([]);

    assert({
      given: '<html data-theme> rendered from the classic theme cookie',
      should:
        'select color-scheme in CSS alone, defaulting to system as classic does',
      actual: [
        declsOf(css, ':root')['color-scheme'],
        declsOf(css, ":root[data-theme='system']")['color-scheme'],
        declsOf(css, ":root[data-theme='light']")['color-scheme'],
        declsOf(css, ":root[data-theme='dark']")['color-scheme'],
      ],
      expected: ['light dark', 'light dark', 'light', 'dark'],
    });
  });

  test('prefers-reduced-motion', async () => {
    const css = await compile(['pane-motion']);
    const reduced: Record<string, string> = {};
    css.walkAtRules('media', (media: AtRule) => {
      if (!/prefers-reduced-motion:\s*reduce/.test(media.params)) return;
      media.walkRules((rule) => {
        if (!rule.selector.split(',').map((s) => s.trim()).includes('*'))
          return;
        rule.walkDecls((decl) => {
          reduced[decl.prop] = `${decl.value}${decl.important ? ' !important' : ''}`;
        });
      });
    });

    assert({
      given: 'a viewer who prefers reduced motion',
      should: 'zero every transition and animation duration and delay',
      actual: reduced,
      expected: {
        'animation-duration': '0s !important',
        'animation-delay': '0s !important',
        'animation-iteration-count': '1 !important',
        'transition-duration': '0s !important',
        'transition-delay': '0s !important',
        'scroll-behavior': 'auto !important',
      },
    });
  });
});
