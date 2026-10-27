/**
 * Registry path-template segment kinds (ADR 0004 §3.2; G1c R17): a `{name}`
 * placeholder for exactly one segment, a `{name+}` placeholder for one or more
 * trailing segments, or a literal. Pure.
 */
const SINGLE_RE = /^\{([A-Za-z][A-Za-z0-9_]*)\}$/;
const MULTI_RE = /^\{([A-Za-z][A-Za-z0-9_]*)\+\}$/;

export type TemplateSegment =
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'single'; readonly slot: string }
  | { readonly kind: 'multi'; readonly slot: string };

export function parseTemplateSegment(segment: string): TemplateSegment {
  const single = SINGLE_RE.exec(segment);
  if (single !== null) return { kind: 'single', slot: single[1]! };
  const multi = MULTI_RE.exec(segment);
  if (multi !== null) return { kind: 'multi', slot: multi[1]! };
  return { kind: 'literal', text: segment };
}
