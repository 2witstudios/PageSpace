import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, it, expect, beforeAll, afterEach } from 'vitest';

/**
 * The touch-reveal rules in globals.css are blunt attribute-substring selectors.
 * Everything else about this feature is unit-tested, but until now the selectors
 * themselves were only ever verified by reading the compiled CSS — nothing failed
 * if they stopped matching the controls they exist to reveal, or started matching
 * something they must not touch.
 *
 * This reads the SELECTORS OUT OF globals.css (rather than restating them, which
 * would only test a copy of itself) and runs them against the real class strings
 * from the components, so the CSS and the markup are pinned to each other.
 */

const here = dirname(fileURLToPath(import.meta.url));
const GLOBALS_CSS = resolve(here, '../globals.css');

/** Selectors of every unlayered rule keyed on the coarse-pointer stamp. */
let revealSelector: string;
let displaySelectors: string[];

beforeAll(() => {
  const css = readFileSync(GLOBALS_CSS, 'utf8');

  // Rule bodies are `:where([data-pointer='coarse']) <selector> { ... }`. Capture
  // the FULL selector including the `:where()` ancestor — dropping it would leave
  // the desktop assertion below testing nothing, since every rule would match
  // regardless of whether <html> carries the stamp.
  const rules = [...css.matchAll(/(:where\(\[data-pointer='coarse'\]\)[^{]+)\{([^}]+)\}/g)].map(
    (m) => ({ selector: m[1].replace(/\s+/g, ' ').trim(), body: m[2] }),
  );

  const reveal = rules.filter((r) => r.body.includes('opacity: 1'));
  expect(reveal, 'globals.css should contain exactly one opacity reveal rule').toHaveLength(1);
  revealSelector = reveal[0].selector;

  displaySelectors = rules.filter((r) => r.body.includes('display:')).map((r) => r.selector);
  expect(displaySelectors.length, 'globals.css should contain display reveal rules').toBeGreaterThan(0);
});

/** Does an element with this class list get revealed on a coarse-pointer device? */
function isRevealed(className: string, attrs: Record<string, string> = {}): boolean {
  document.documentElement.setAttribute('data-pointer', 'coarse');
  const el = document.createElement('div');
  el.className = className;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return document.querySelectorAll(revealSelector).length === 1;
}

function isDisplayRevealed(className: string, attrs: Record<string, string> = {}): boolean {
  document.documentElement.setAttribute('data-pointer', 'coarse');
  const el = document.createElement('div');
  el.className = className;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return displaySelectors.some((s) => document.querySelectorAll(s).length === 1);
}

afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-pointer');
});

describe('touch reveal rules — controls that MUST become visible', () => {
  // Class strings copied verbatim from the components they belong to.
  const REVEALED: Array<[string, string]> = [
    [
      'MessageActionButtons — AI chat retry/edit/copy/delete (the headline bug)',
      'flex items-center space-x-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity',
    ],
    [
      'ui/sidebar SidebarMenuAction — page-tree row actions (md: viewport gate)',
      'peer-data-[active=true]/menu-button:text-sidebar-accent-foreground group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 data-[state=open]:opacity-100 md:opacity-0',
    ],
    [
      'TerminalPanes — the md: gate master re-introduced in #2006',
      'absolute right-1.5 top-1.5 z-10 flex items-center opacity-100 transition-opacity focus-within:opacity-100 md:opacity-0 md:group-hover/pane:opacity-100',
    ],
    [
      'MessageHoverToolbar — named group + pointer-events-none',
      'opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100 pointer-events-none group-hover/msg:pointer-events-auto',
    ],
    [
      'TabItem close button',
      'ml-1 rounded-sm p-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100',
    ],
    [
      'prompt-input remove-attachment button',
      'absolute inset-0 size-5 rounded p-0 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100',
    ],
    [
      'SidebarActivityTab sub-item — sm: gate + named group',
      'h-5 w-5 sm:opacity-0 sm:group-hover/item:opacity-100 transition-opacity flex-shrink-0',
    ],
  ];

  it.each(REVEALED)('reveals %s', (_name, className) => {
    expect(isRevealed(className)).toBe(true);
  });

  it('does nothing at all on a desktop device (no data-pointer stamp)', () => {
    const el = document.createElement('div');
    el.className = 'flex items-center sm:opacity-0 sm:group-hover:opacity-100';
    document.body.appendChild(el);
    // No data-pointer on <html> — the ancestor condition fails, so no rule can match.
    expect(document.querySelectorAll(revealSelector)).toHaveLength(0);
  });
});

describe('touch reveal rules — decoration that MUST STAY hidden', () => {
  const OPTED_OUT: Array<[string, string]> = [
    [
      'FeedbackDialog screenshot scrim (would black out the preview)',
      'absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity',
    ],
    [
      'resizable drag seam',
      'h-full w-px bg-sidebar-border transition-opacity group-hover:opacity-100 group-data-[separator=active]:opacity-100 opacity-0',
    ],
    [
      'ChannelView message timestamp',
      'absolute inset-y-0 right-2 flex items-center opacity-0 group-hover/msg:opacity-100 transition-opacity tabular-nums',
    ],
    [
      'StatusConfigManager slug hint',
      'text-xs text-muted-foreground ml-auto opacity-0 group-hover:opacity-100',
    ],
  ];

  it.each(OPTED_OUT)('keeps %s hidden via data-hover-only', (_name, className) => {
    expect(isRevealed(className, { 'data-hover-only': '' })).toBe(false);
    // ...and would otherwise have been revealed, so the opt-out is load-bearing.
    expect(isRevealed(className)).toBe(true);
  });

  it('never pins a hover FADE-OUT visible — it would cover the content beneath it', () => {
    // prompt-input.tsx: the attachment thumbnail that fades out to expose its
    // remove button. Forcing opacity:1 here would be an inversion.
    expect(
      isRevealed('absolute inset-0 flex size-5 rounded bg-background transition-opacity group-hover:opacity-0'),
    ).toBe(false);
  });

  it('still excludes a fade-out that later grows an :opacity-100 variant (the landmine)', () => {
    // This is the case the `:not([class*='group-hover:opacity-0'])` guard exists for.
    // Without it, adding focus-within:opacity-100 to a scrim pins the scrim VISIBLE.
    expect(
      isRevealed('absolute inset-0 bg-black/50 transition-opacity group-hover:opacity-0 focus-within:opacity-100'),
    ).toBe(false);
  });
});

describe('touch reveal rules — display-based reveals', () => {
  it('reveals a hidden group-hover:flex control', () => {
    expect(isDisplayRevealed('hidden group-hover:flex items-center gap-1')).toBe(true);
  });

  it('keeps TabItem’s Cmd+N shortcut hint hidden — it is a keyboard affordance', () => {
    expect(
      isDisplayRevealed('text-[10px] text-white/70 flex-shrink-0 hidden group-hover:inline', {
        'data-hover-only': '',
      }),
    ).toBe(false);
  });

  it('does not let group-hover:flex-row masquerade as a display reveal', () => {
    // Exact-token (`~=`) matching, not substring: a flex-DIRECTION change on hover
    // must not be forced to `display: flex` on touch.
    expect(isDisplayRevealed('flex group-hover:flex-row items-center')).toBe(false);
  });
});
