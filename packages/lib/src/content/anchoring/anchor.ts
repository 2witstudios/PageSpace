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

/*
 * BigInt CALLS, not BigInt literals.
 *
 * `0xcbf29ce484222325n` requires an ES2020 target. This module is pure and was
 * only ever imported by other lib code until `tag-service` reached it, and
 * `apps/web` compiles at ES2018 — so the moment anything in the web app pulled
 * this file in transitively, `web#build` failed with "BigInt literals are not
 * available when targeting lower than ES2020". The literal was latent, not
 * safe.
 *
 * `BigInt('0x…')` is a runtime call rather than literal syntax, compiles at
 * ES2018, and produces the identical value — so `hashText` output is unchanged
 * and every anchor already stored still verifies. Raising the web app's target
 * would also work, but that is a build-wide change to fix one constant here.
 */
const FNV_OFFSET_BASIS = BigInt('0xcbf29ce484222325');
const FNV_PRIME = BigInt('0x100000001b3');
const FNV_MASK = BigInt('0xffffffffffffffff');

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
