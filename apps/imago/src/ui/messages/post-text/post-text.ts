// A post's text split into plain runs and mentions. Mentions are stored inline
// as `@[label](id:type)`, the format classic's composer writes and its
// RichText and expand-group-mentions read; anything else, markup included,
// is text.

export type PostPart =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'mention';
      readonly label: string;
      readonly id: string;
      /** `user`, `page`, `everyone`, `role`, … as stored. */
      readonly type: string;
      /** It calls the viewer: their user mention, or @everyone. */
      readonly you: boolean;
    };

/** classic RichText's preprocessMentions pattern. */
const mentionPattern = /@\[([^\]]+)\]\(([^:)]+):([^)]+)\)/g;

const callsViewer = (id: string, type: string, viewerId: string): boolean =>
  (type === 'user' && id === viewerId) || type === 'everyone';

export const postParts = (text: string, viewerId: string): readonly PostPart[] => {
  const parts: PostPart[] = [];
  let from = 0;
  for (const match of text.matchAll(mentionPattern)) {
    const [whole, label = '', id = '', type = ''] = match;
    const at = match.index;
    if (at > from) parts.push({ kind: 'text', text: text.slice(from, at) });
    parts.push({ kind: 'mention', label, id, type, you: callsViewer(id, type, viewerId) });
    from = at + whole.length;
  }
  if (from < text.length) parts.push({ kind: 'text', text: text.slice(from) });
  return parts;
};

/** Whether a post calls the viewer. */
export const mentionsViewer = (text: string, viewerId: string): boolean =>
  postParts(text, viewerId).some((part) => part.kind === 'mention' && part.you);
