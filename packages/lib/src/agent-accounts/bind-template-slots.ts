/**
 * `bindTemplateSlots` — match a registry path template against a canonical
 * path (ADR 0004 §3.2, M8; slot matching fully specified in G1c R17).
 *
 * The whole path must match — no prefix match. A `{slot}` matches exactly ONE
 * non-empty segment; a trailing `{slot+}` matches one or more non-empty
 * segments, bound as those segments joined by `/`; a literal must be equal as
 * canonical text. A path with an empty segment (`//`, a trailing `/`) matches
 * nothing. The path is already canonical (normalized, never decoded), so an
 * encoded `/` inside a segment never adds a segment, and a slot value is the
 * segment exactly as the executor sends it.
 *
 * Returns the `[slot, value]` pairs in template order and the template's
 * SPECIFICITY — one rank per template segment (literal 2, `{slot}` 1,
 * `{slot+}` 0) — which `lookupOperation` compares from the left so a literal
 * beats a slot and a single-segment slot beats a multi-segment one. `null`
 * when the template does not match or is not well-formed.
 *
 * Pure.
 */
import { parseTemplateSegment } from './parse-template-segment';

export type TemplateMatch = {
  readonly slots: readonly (readonly [string, string])[];
  readonly specificity: readonly number[];
};

const RANK = { literal: 2, single: 1, multi: 0 } as const;

export function bindTemplateSlots({ pathTemplate, path }: { readonly pathTemplate: string; readonly path: string }): TemplateMatch | null {
  if (!pathTemplate.startsWith('/') || !path.startsWith('/')) return null;
  const templateSegments = pathTemplate.slice(1).split('/').map(parseTemplateSegment);
  const pathSegments = path.slice(1).split('/');
  if (pathSegments.some((segment) => segment.length === 0)) return null;

  const slots: (readonly [string, string])[] = [];
  const specificity: number[] = [];
  for (let index = 0; index < templateSegments.length; index += 1) {
    const segment = templateSegments[index]!;
    specificity.push(RANK[segment.kind]);
    if (segment.kind === 'multi') {
      if (index !== templateSegments.length - 1) return null;
      const rest = pathSegments.slice(index);
      if (rest.length === 0) return null;
      slots.push([segment.slot, rest.join('/')]);
      return { slots, specificity };
    }
    const actual = pathSegments[index];
    if (actual === undefined) return null;
    if (segment.kind === 'single') {
      slots.push([segment.slot, actual]);
    } else if (segment.text.length === 0 || segment.text !== actual) {
      return null;
    }
  }
  return pathSegments.length === templateSegments.length ? { slots, specificity } : null;
}
