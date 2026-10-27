/**
 * The Sprite name for a browser session — deterministic, so every web
 * instance finds the same Sprite for the same session without shared state.
 * The name becomes ONE DNS label together with the org suffix
 * (`<name>-<org>.sprites.app`), so it stays within 48 characters, the same
 * budget `sandbox-client/sprites.ts` uses for agent sandboxes.
 */
export const BROWSER_SPRITE_NAME_MAX = 48;

export const browserSpriteName = (sessionId: string): string =>
  `bws-${sessionId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^bws-+/, '')}`.slice(0, BROWSER_SPRITE_NAME_MAX);
