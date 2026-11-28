import { describe, it, expect, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ insertCSS: vi.fn() }));
vi.mock('../state', () => ({ mainWindow: { webContents: { insertCSS: hoisted.insertCSS } } }));

import { buildDesktopCss } from '../desktop-css';
import { injectDesktopStyles } from '../window-injections';

type Rule = { readonly selector: string; readonly body: string };

/** Splits a stylesheet into its flat rules: the selector list and the declarations. */
function rulesOf(css: string): readonly Rule[] {
  return css
    .split('}')
    .map((chunk) => chunk.split('{'))
    .filter((parts): parts is [string, string] => parts.length === 2)
    .map(([selector, body]) => ({ selector: selector.replace(/\s+/g, ' ').trim(), body: body.replace(/\s+/g, ' ').trim() }));
}

/** The rules whose selector list names the given selector text, so a test can state what applies to what. */
const rulesFor = (css: string, selector: string): readonly Rule[] =>
  rulesOf(css).filter((rule) => rule.selector.split(',').some((part) => part.trim() === selector));

const FRAME = '[data-desktop-frame]';

describe('buildDesktopCss()', () => {
  it('gives the generic header and nav drag regions on every platform', () => {
    for (const isMacOS of [true, false]) {
      const drag = rulesOf(buildDesktopCss(isMacOS)).find((rule) => rule.selector.startsWith('header:not(aside *)'));
      expect({ isMacOS, drag: drag?.body }).toStrictEqual({ isMacOS, drag: '-webkit-app-region: drag;' });
    }
  });

  it('pads the generic nav and header by 80px on macOS only, and never inside an imago frame', () => {
    const mac = buildDesktopCss(true);
    const padded = rulesOf(mac).filter((rule) => rule.body === 'padding-left: 80px !important;');
    const selectors = padded.flatMap((rule) => rule.selector.split(',').map((part) => part.trim()));
    expect({
      rules: padded.length,
      selectors: selectors.length,
      everySelectorExcludesFrame: selectors.every((selector) => selector.endsWith(`:not(${FRAME} *)`)),
    }).toStrictEqual({ rules: 1, selectors: 5, everySelectorExcludesFrame: true });
    expect(buildDesktopCss(false)).not.toContain('padding-left: 80px');
  });

  it('insets the imago spine by 44px on macOS so the traffic lights clear the drive tile', () => {
    expect(rulesFor(buildDesktopCss(true), `${FRAME} nav[aria-label="Sections"]`)).toStrictEqual([
      { selector: `${FRAME} nav[aria-label="Sections"]`, body: 'padding-top: 44px !important;' },
    ]);
    expect(buildDesktopCss(false)).not.toContain('padding-top: 44px');
  });

  it('marks the explicit drag regions inside imago, with the tabs kept no-drag', () => {
    const css = buildDesktopCss(true);
    expect({
      drag: rulesFor(css, `${FRAME} [data-desktop-drag]`).map((rule) => rule.body),
      tabs: rulesFor(css, `${FRAME} [role="tab"]`).map((rule) => rule.body),
      tabChildren: rulesFor(css, `${FRAME} [role="tab"] *`).map((rule) => rule.body),
    }).toStrictEqual({
      drag: ['-webkit-app-region: drag;'],
      tabs: ['-webkit-app-region: no-drag;'],
      tabChildren: ['-webkit-app-region: no-drag;'],
    });
  });

  it('keeps buttons, links and inputs no-drag everywhere', () => {
    expect(rulesFor(buildDesktopCss(true), 'button').map((rule) => rule.body)).toStrictEqual(['-webkit-app-region: no-drag;']);
  });
});

describe('injectDesktopStyles()', () => {
  it('inserts the built CSS into the main window', () => {
    hoisted.insertCSS.mockClear();
    injectDesktopStyles();
    expect(hoisted.insertCSS).toHaveBeenCalledWith(buildDesktopCss(process.platform === 'darwin'));
  });
});
