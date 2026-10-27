import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';

const appDir = dirname(fileURLToPath(import.meta.url));
const files = ['globals.css', 'theme/frame.css', 'theme/v3.css'].map((file) => join(appDir, file));

/** Every custom property declared in a `@theme` block or on `:root`, by name. */
const declared = (): Map<string, string> => {
  const tokens = new Map<string, string>();
  for (const file of files) {
    const root = postcss.parse(readFileSync(file, 'utf8'));
    root.walkAtRules('theme', (block) => block.walkDecls(/^--/, (decl) => void tokens.set(decl.prop, decl.value)));
    root.walkRules(':root', (rule) => rule.walkDecls(/^--/, (decl) => void tokens.set(decl.prop, decl.value)));
  }
  return tokens;
};

const tokens = declared();
const pick = (names: string[]) => Object.fromEntries(names.map((name) => [name, tokens.get(name)]));

describe('Imago C v3 tokens (IMC-1.2)', () => {
  test('frame geometry', () => {
    assert({
      given: 'SPEC v3 column widths and head heights',
      should: 'size the spine 72, panes 260 (stage-2 300), Imago 360, heads 48, tab bar 40, toolbar strip 44',
      actual: pick([
        '--spacing-rail-width',
        '--spacing-tree-pane',
        '--spacing-list-pane',
        '--spacing-chat-pane',
        '--spacing-pane-header',
        '--spacing-tab-bar',
        '--spacing-toolbar-strip',
        '--spacing-thread-sheet',
        '--radius-stage',
      ]),
      expected: {
        '--spacing-rail-width': '72px',
        '--spacing-tree-pane': '260px',
        '--spacing-list-pane': '300px',
        '--spacing-chat-pane': '360px',
        '--spacing-pane-header': '48px',
        '--spacing-tab-bar': '40px',
        '--spacing-toolbar-strip': '44px',
        '--spacing-thread-sheet': '360px',
        '--radius-stage': '22px',
      },
    });
  });

  test('palette (light values)', () => {
    const light = (name: string) => tokens.get(name)?.match(/^light-dark\(\s*(oklch\([^)]*\))/)?.[1];
    assert({
      given: 'the SPEC v3 token list',
      should: 'carry its light values exactly',
      actual: Object.fromEntries(
        ['--spine', '--tint', '--tab-bar', '--fill', '--hairline', '--accent-deep', '--status-success', '--status-danger', '--notice',
          '--type-tasks', '--type-sheet', '--type-channel', '--type-folder', '--type-agent', '--type-canvas', '--type-code', '--type-file']
          .map((name) => [name, light(name)]),
      ),
      expected: {
        '--spine': 'oklch(0.35 0.08 235)',
        '--tint': 'oklch(0.982 0.005 235)',
        '--tab-bar': 'oklch(0.935 0.008 235)',
        '--fill': 'oklch(0.15 0.01 220 / 0.04)',
        '--hairline': 'oklch(0.9 0.005 230 / 0.8)',
        '--accent-deep': 'oklch(0.38 0.16 235)',
        '--status-success': 'oklch(0.55 0.15 145)',
        '--status-danger': 'oklch(0.577 0.245 27)',
        '--notice': 'oklch(0.7 0.17 50)',
        '--type-tasks': 'oklch(0.55 0.15 145)',
        '--type-sheet': 'oklch(0.52 0.13 160)',
        '--type-channel': 'oklch(0.55 0.14 300)',
        '--type-folder': 'oklch(0.62 0.12 75)',
        '--type-agent': 'oklch(0.55 0.15 25)',
        '--type-canvas': 'oklch(0.58 0.16 350)',
        '--type-code': 'oklch(0.45 0.03 250)',
        '--type-file': 'oklch(0.5 0.01 220)',
      },
    });
  });

  test('every v3 colour has a dark value', () => {
    const v3 = postcss.parse(readFileSync(join(appDir, 'theme/v3.css'), 'utf8'));
    const missing: string[] = [];
    v3.walkRules(':root', (rule) => rule.walkDecls(/^--/, (decl) => {
      if (!decl.value.startsWith('light-dark(')) missing.push(decl.prop);
    }));
    assert({ given: 'the v3 :root colours', should: 'all use light-dark()', actual: missing, expected: [] });
  });
});
