/**
 * Markdown constructs the ProseMirror schema has no node or mark for.
 *
 * `contentMode='markdown'` documents are stored as markdown source, not HTML,
 * so they cannot be round-tripped through the schema the way an HTML document
 * can — there is nothing to diff against until they are migrated onto this
 * surface. This is therefore SOURCE-SYNTAX detection, not a measured loss: it
 * answers "what would Phase K have to carry across", which is the question the
 * census is being asked about them.
 */
const CONSTRUCT_PATTERNS: ReadonlyArray<readonly [construct: string, pattern: RegExp]> = [
  ['md:image', /!\[[^\]]*\]\(/],
  ['md:task-list', /^\s*[-*+]\s+\[[ xX]\]\s/],
  ['md:heading-4-6', /^\s{0,3}#{4,6}\s/],
  ['md:html-block', /^\s{0,3}<[a-zA-Z!/]/],
  ['md:footnote', /\[\^[^\]]+\]/],
  ['md:highlight', /==[^=\n]+==/],
  ['md:strikethrough', /~~[^~\n]+~~/],
];

const FENCE = /^\s{0,3}(```|~~~)/;

export function markdownConstructs(markdown: string): string[] {
  const found = new Set<string>();
  let insideFence = false;

  for (const line of markdown.split('\n')) {
    // A fenced block is literal text: `![alt](a.png)` inside one is an example
    // of markdown, not an image, and counting it would inflate every page that
    // documents the syntax.
    if (FENCE.test(line)) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;

    for (const [construct, pattern] of CONSTRUCT_PATTERNS) {
      if (pattern.test(line)) {
        found.add(construct);
      }
    }
  }

  return [...found].sort();
}
