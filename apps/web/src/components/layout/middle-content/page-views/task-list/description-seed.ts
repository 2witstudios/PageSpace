export type DescriptionSeed =
  | { kind: 'skip' }
  | { kind: 'seed'; content: string }
  | { kind: 'fetch' };

/**
 * How a task list description gets its first content. Only a real string seeds; null or absent content
 * fetches, because seeding '' for unknown content lets the next autosave blank the stored description.
 */
export function resolveDescriptionSeed({
  hasCachedDocument,
  initialContent,
}: {
  hasCachedDocument: boolean;
  initialContent: string | null | undefined;
}): DescriptionSeed {
  if (hasCachedDocument) return { kind: 'skip' };
  if (typeof initialContent === 'string') return { kind: 'seed', content: initialContent };
  return { kind: 'fetch' };
}
