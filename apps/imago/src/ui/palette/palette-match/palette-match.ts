/** A run of a result's title, and whether it is part of what was typed. */
export type MatchPart = {
  readonly text: string;
  readonly match: boolean;
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A title cut into the runs the query's words match and the runs between,
 * ignoring case, so the palette can tint what the search found. Words are
 * tried longest first, so "road roadmap" tints all of "Roadmap". A blank
 * query, or one that matches nothing, is the whole title as one plain run.
 */
export const matchParts = (title: string, query: string): readonly MatchPart[] => {
  const words = [...new Set(query.trim().split(/\s+/).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (words.length === 0) return [{ text: title, match: false }];
  const pattern = new RegExp(`(${words.map(escapeRegExp).join('|')})`, 'gi');
  // Split on a capturing group: the captured matches land at the odd places.
  return title
    .split(pattern)
    .map((text, index) => ({ text, match: index % 2 === 1 }))
    .filter((part) => part.text !== '');
};
