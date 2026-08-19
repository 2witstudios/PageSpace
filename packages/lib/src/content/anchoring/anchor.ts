/**
 * Anchor construction: turn a selection in a projection into a durable
 * TextAnchor.
 *
 * The hash here is a hand-rolled FNV-1a rather than `node:crypto` for the same
 * reason the HTML tokenizer is hand-rolled: this code runs on both the server
 * and the client, and both sides must agree byte-for-byte. It is a drift
 * detector, not a security primitive — do not use it where collision resistance
 * matters.
 *
 * Zero I/O — no db, no fetch, no clock, no env — enforced by the purity test in
 * __tests__/purity.test.ts.
 *
 * @module @pagespace/lib/content/anchoring/anchor
 */

import type { TextAnchor } from './types';

/** How much surrounding text a TextAnchor carries on each side. ~64 bytes total. */
export const ANCHOR_CONTEXT_LENGTH = 32;

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;

/**
 * FNV-1a over the UTF-16 code units of `text`, as 16 lowercase hex chars.
 * Deterministic and identical on every JS runtime.
 */
export function hashText(text: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash ^ BigInt(text.charCodeAt(i))) * FNV_PRIME) & FNV_MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

export type CreateAnchorOptions = {
  /** `pages.revision` at the moment of anchoring. */
  revision: number;
};

/**
 * Build a TextAnchor for `[start, end)` of `text`, where `text` is already a
 * projection (see text-projection.ts) — never a stored content blob.
 *
 * Out-of-range and reversed offsets are clamped and normalised rather than
 * rejected, so a caller that hands over a stale selection still gets a usable,
 * self-consistent anchor.
 */
export function createAnchor(
  text: string,
  start: number,
  end: number,
  opts: CreateAnchorOptions
): TextAnchor {
  const clamp = (value: number): number => {
    if (Number.isNaN(value)) {
      return 0;
    }
    return Math.min(Math.max(Math.trunc(value), 0), text.length);
  };

  const a = clamp(start);
  const b = clamp(end);
  const from = Math.min(a, b);
  const to = Math.max(a, b);

  return {
    v: 1,
    exact: text.slice(from, to),
    prefix: text.slice(Math.max(0, from - ANCHOR_CONTEXT_LENGTH), from),
    suffix: text.slice(to, to + ANCHOR_CONTEXT_LENGTH),
    start: from,
    end: to,
    revision: opts.revision,
    textHash: hashText(text),
  };
}
