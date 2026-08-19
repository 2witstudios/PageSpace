/**
 * Shared types for the content-anchoring primitive: a page-type-agnostic way
 * to keep a durable pointer into prose that users then edit. Tags are the
 * first consumer; per-content comments are the intended second.
 *
 * Zero I/O — no db, no fetch, no clock, no env — enforced by the purity test
 * in __tests__/purity.test.ts.
 *
 * @module @pagespace/lib/content/anchoring/types
 */

/**
 * A W3C-Web-Annotation-style quote selector plus a positional hint.
 *
 * `start`/`end` are offsets into the *projection* of the page content (see
 * text-projection.ts), never into the stored blob. They are a hint: ordinary
 * edits are forward-ported through the diff (reanchor.ts), and when there is
 * no predecessor to diff against the quote + context repairs them (resolve.ts).
 */
export type TextAnchor = {
  /** Schema version. Bump when the shape changes so old rows stay readable. */
  v: 1;
  /** The quoted text, as it read in the projection when the anchor was made. */
  exact: string;
  /** Up to ANCHOR_CONTEXT_LENGTH chars of projected text immediately before `exact`. */
  prefix: string;
  /** Up to ANCHOR_CONTEXT_LENGTH chars of projected text immediately after `exact`. */
  suffix: string;
  /** Offset into the projection — a hint, allowed to drift. */
  start: number;
  /** Exclusive end offset into the projection — a hint, allowed to drift. */
  end: number;
  /** `pages.revision` at the moment the anchor was created. */
  revision: number;
  /** Hash of the whole projection the anchor was measured against. */
  textHash: string;
};

/**
 * Sheet cells need no text anchoring: `(sheet name, A1 address)` is already a
 * natural key inside the SheetDoc.
 */
export type SheetCellAnchor = {
  v: 1;
  sheet: string;
  address: string;
};

/**
 * Where an anchor landed.
 *
 * - `exact`   — found at the recorded offsets, byte-for-byte.
 * - `shifted` — the quote is intact but has moved.
 * - `fuzzy`   — an approximate match survived above the similarity floor.
 * - `orphaned` — the anchored text is gone. This is GitHub's *outdated* state.
 *
 * `confidence` is in [0, 1].
 */
export type AnchorResolution =
  | { status: 'exact' | 'shifted' | 'fuzzy'; start: number; end: number; confidence: number }
  | { status: 'orphaned' };
