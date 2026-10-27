/**
 * `userColor(userId)` — one deterministic colour per user, so the avatar ring
 * in the presence roster and the `CollaborationCaret` label agree with zero
 * coordination between them. Two clients that have never spoken must pick
 * the same colour for the same user, so the only input is the id.
 */
import { describe, it, expect, vi } from 'vitest';
import { userColor, USER_COLOR_PALETTE } from '../user-color.js';

/** WCAG 2.x relative luminance, written out here rather than imported so the test does not share code with the module it checks. */
function relativeLuminance(hex: string): number {
  /** One sRGB channel, linearised. */
  const channel = (index: number): number => {
    const c = Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/** WCAG contrast ratio between two `#rrggbb` colours, lighter over darker. */
function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The two backgrounds a caret or ring is drawn over. Light is pure white —
 * the worst case, since the app's `--background` (oklch 0.995) is darker than
 * that. Dark is the app's `--card` (oklch 0.23 0 0 ≈ #1d1d1d), the LIGHTEST
 * dark surface: contrast against a darker one is always higher, so passing
 * here passes everywhere.
 */
const LIGHT_BACKGROUND = '#ffffff';
const DARK_BACKGROUND = '#1d1d1d';

/** WCAG 1.4.11 (non-text contrast) — the bar for UI components and graphical objects, which is what a caret and an avatar ring are. */
const MINIMUM_UI_CONTRAST = 3;

describe('userColor', () => {
  it('gives the same userId the same colour on every call', () => {
    expect(userColor('usr_alpha')).toBe(userColor('usr_alpha'));
  });

  it('gives the same userId the same colour on two clients that share nothing but the module', async () => {
    // A fresh module instance per "client": no cache, no process-level state
    // can be what makes the two answers agree.
    vi.resetModules();
    const clientA = await import('../user-color.js');
    vi.resetModules();
    const clientB = await import('../user-color.js');
    // Client A has met other users first; client B meets usr_beta cold. A
    // first-come assignment table would give them different answers.
    clientA.userColor('usr_gamma');
    clientA.userColor('usr_delta');
    expect(clientA.userColor('usr_beta')).toBe(clientB.userColor('usr_beta'));
  });

  it('is pinned: a change to the hash or the palette changes every existing user’s colour', () => {
    // A snapshot, deliberately. Colours are shown to people who learn them;
    // silently re-hashing everyone is a visible regression, so it must be a
    // visible diff here first.
    expect(userColor('usr_1')).toBe('#558920');
    expect(userColor('usr_2')).toBe('#218f21');
    expect(userColor('')).toBe('#218d57');
  });

  it('always answers with a palette member as lowercase #rrggbb', () => {
    for (const id of ['', 'a', 'usr_1', 'clh0000000000000000000000', '🙂', 'x'.repeat(500)]) {
      const color = userColor(id);
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
      expect(USER_COLOR_PALETTE).toContain(color);
    }
  });

  it('spreads users across the whole palette rather than a corner of it', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      seen.add(userColor(`usr_${i}`));
    }
    expect(seen.size).toBe(USER_COLOR_PALETTE.length);
  });

  it('distinguishes ids that a weak hash would collide', () => {
    // Same characters, different order — a sum-of-char-codes hash maps these
    // to one colour.
    expect(userColor('usr_ab')).not.toBe(userColor('usr_ba'));
  });
});

describe('USER_COLOR_PALETTE', () => {
  it.each(USER_COLOR_PALETTE)('%s meets 3:1 against the light theme background', (color) => {
    expect(contrastRatio(color, LIGHT_BACKGROUND)).toBeGreaterThanOrEqual(MINIMUM_UI_CONTRAST);
  });

  it.each(USER_COLOR_PALETTE)('%s meets 3:1 against the dark theme background', (color) => {
    expect(contrastRatio(color, DARK_BACKGROUND)).toBeGreaterThanOrEqual(MINIMUM_UI_CONTRAST);
  });

  it('has no duplicate entries', () => {
    expect(new Set(USER_COLOR_PALETTE).size).toBe(USER_COLOR_PALETTE.length);
  });
});
