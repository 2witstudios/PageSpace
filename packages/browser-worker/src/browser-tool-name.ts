/**
 * The agent-facing browser tools, one per typed operation. `web_fetch` is
 * not superseded by any of these (G6a brief item 3).
 */
export const BROWSER_TOOL_NAMES = [
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_read',
  'browser_screenshot',
  'browser_tabs',
] as const;
export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];

/**
 * Tools that change the page or the web (a navigation, a click, typed text or
 * a new tab can submit a form). Read-only agents never get them.
 */
export const BROWSER_MUTATING_TOOL_NAMES: readonly BrowserToolName[] = Object.freeze([
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_tabs',
]);
