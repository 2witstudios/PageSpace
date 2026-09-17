/** Whether a registry path-template segment is a `{name}` placeholder for one whole segment. Pure. */
const PLACEHOLDER_RE = /^\{[A-Za-z][A-Za-z0-9_]*\}$/;

export function isPlaceholderSegment(segment: string): boolean {
  return PLACEHOLDER_RE.test(segment);
}
