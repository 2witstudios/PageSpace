/**
 * `templateMatchesPath` — does a registry path template match a canonical
 * path? Segment by segment: a `{name}` placeholder matches exactly ONE
 * non-empty segment, every other segment must be equal as canonical text.
 * The path is already canonical (normalized, never decoded), so an encoded
 * `/` inside a segment can never make a template match more segments.
 *
 * Pure.
 */
import { isPlaceholderSegment } from './is-placeholder-segment';

export function templateMatchesPath({ pathTemplate, path }: { readonly pathTemplate: string; readonly path: string }): boolean {
  const templateSegments = pathTemplate.split('/');
  const pathSegments = path.split('/');
  if (templateSegments.length !== pathSegments.length) return false;
  return templateSegments.every((segment, index) => {
    const actual = pathSegments[index]!;
    return isPlaceholderSegment(segment) ? actual.length > 0 : segment === actual;
  });
}
