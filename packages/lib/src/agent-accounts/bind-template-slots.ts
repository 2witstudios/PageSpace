/**
 * `bindTemplateSlots` — match a registry path template against a canonical
 * path and return the `[slot, segment]` pairs it binds, sorted by slot; `null`
 * when it does not match. A `{slot}` matches exactly ONE non-empty segment and
 * every other segment must be equal as canonical text. The path is already
 * canonical (normalized, never decoded), so an encoded `/` inside a segment
 * can never make a template match more segments, and a slot value is the
 * segment exactly as the executor sends it (ADR 0004 §3.2, M8).
 *
 * Pure.
 */
import { isPlaceholderSegment } from './is-placeholder-segment';

export function bindTemplateSlots({
  pathTemplate,
  path,
}: {
  readonly pathTemplate: string;
  readonly path: string;
}): readonly (readonly [string, string])[] | null {
  const templateSegments = pathTemplate.split('/');
  const pathSegments = path.split('/');
  if (templateSegments.length !== pathSegments.length) return null;
  const bound: (readonly [string, string])[] = [];
  for (let index = 0; index < templateSegments.length; index += 1) {
    const segment = templateSegments[index]!;
    const actual = pathSegments[index]!;
    if (isPlaceholderSegment(segment)) {
      if (actual.length === 0) return null;
      bound.push([segment.slice(1, -1), actual]);
    } else if (segment !== actual) {
      return null;
    }
  }
  return bound.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
