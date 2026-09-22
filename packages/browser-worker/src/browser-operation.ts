/**
 * The typed operations a browser session accepts — the WHOLE agent surface.
 *
 * Codex's Phase-5 rewrite and S3 R4 fix the shape: navigate, click, type,
 * read (accessibility tree), screenshot and tabs. Nothing else exists as a
 * variant, so there is no way to phrase a raw CDP call, a script evaluation,
 * a cookie or storage read, an extension install or a download through this
 * type — adding one is a change to this union that every `Record` keyed on
 * it fails to typecheck without.
 *
 * Elements are addressed by the `ref` an accessibility snapshot printed
 * (`[ref=e12]`), never by a CSS selector or a script: a selector language is
 * a query language over the DOM, and the agent gets no DOM.
 */

export const BROWSER_OPERATION_KINDS = ['navigate', 'click', 'type', 'read', 'screenshot', 'tabs'] as const;
export type BrowserOperationKind = (typeof BROWSER_OPERATION_KINDS)[number];

export type TabAction =
  | { readonly action: 'list' }
  | { readonly action: 'open'; readonly url: string }
  | { readonly action: 'select'; readonly tabId: string }
  | { readonly action: 'close'; readonly tabId: string };

export type BrowserOperation =
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'click'; readonly ref: string }
  | { readonly kind: 'type'; readonly ref: string; readonly text: string; readonly submit: boolean }
  | { readonly kind: 'read' }
  | { readonly kind: 'screenshot' }
  | ({ readonly kind: 'tabs' } & TabAction);

export type PageSummary = {
  readonly tabId: string;
  readonly url: string;
  readonly title: string;
};

export type BrowserOperationResult =
  | { readonly kind: 'navigate'; readonly page: PageSummary }
  | { readonly kind: 'click'; readonly page: PageSummary }
  | { readonly kind: 'type'; readonly page: PageSummary }
  | { readonly kind: 'read'; readonly page: PageSummary; readonly snapshot: string; readonly truncated: boolean }
  | { readonly kind: 'screenshot'; readonly page: PageSummary; readonly image: { readonly mediaType: 'image/jpeg'; readonly base64: string } }
  | { readonly kind: 'tabs'; readonly tabs: readonly PageSummary[]; readonly activeTabId: string | null };

/**
 * Why a session refused an operation. Every refusal is data the tool hands
 * back to the model; none is an exception.
 */
export const BROWSER_REFUSAL_REASONS = [
  'draining',
  'human-control',
  'hydrating',
  'navigation-denied',
  'element-not-found',
  'tab-not-found',
  'observation-suppressed',
  'operation-failed',
] as const;
export type BrowserRefusalReason = (typeof BROWSER_REFUSAL_REASONS)[number];

export type BrowserControlResponse =
  | { readonly ok: true; readonly result: BrowserOperationResult }
  | { readonly ok: false; readonly refusal: { readonly reason: BrowserRefusalReason; readonly detail: string } };

/** Bounds a caller cannot exceed; `parseBrowserOperation` enforces them. */
export const BROWSER_OPERATION_LIMITS = Object.freeze({
  maxUrlLength: 2048,
  maxTextLength: 10_000,
  maxRefLength: 32,
  maxTabIdLength: 64,
});
