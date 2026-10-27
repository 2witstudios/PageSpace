/**
 * `digestBindings` — `hash(canonicalJson(bindings))`, the same bytes the
 * authority signs into a grant and the plane recomputes at resolve (ADR
 * 0005 §2.4). Canonical JSON makes the digest key-order independent; the
 * hash primitive is injected so this stays free of `node:crypto`.
 */
import { canonicalJson } from '../canonical-json';
import type { BindingDigest } from '../grant';
import type { DigestBindings } from './store-adapter';

export const digestBindings: DigestBindings = ({ bindings, hash }) =>
  hash(new TextEncoder().encode(canonicalJson(bindings))) as BindingDigest;
