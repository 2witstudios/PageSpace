/**
 * Pull `:user` mention IDs out of a channel/DM message body.
 *
 * Messages use the `@[Label](id:type)` markdown convention; user mentions are
 * the `type === 'user'` rows. Page mentions (`:page`) are handled by the AI
 * mention processor and are intentionally ignored here.
 *
 * Returned IDs are deduped, in first-seen order. The function never throws —
 * unparseable content yields an empty array.
 */
export function extractMentionedUserIds(content: string): string[] {
  if (!content || content.length === 0) return [];
  const re = /@\[[^\]]{1,500}\]\(([^:)]{1,200}):user\)/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const id = m[1];
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
