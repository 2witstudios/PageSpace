/**
 * `compareSpecificity` — order two template specificities (from
 * `bindTemplateSlots`) segment by segment from the left: the first differing
 * rank decides; when one is a prefix of the other, the longer (more segments
 * pinned) is more specific. Positive when `a` is more specific, 0 for equal
 * shapes (G1c R17). Pure.
 */
export function compareSpecificity(a: readonly number[], b: readonly number[]): number {
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}
