import { MentionType } from '@/types/mentions';

export interface TrackedMention {
  /** Position of '@' in display text */
  start: number;
  /** Position after last character of label in display text */
  end: number;
  label: string;
  id: string;
  type: MentionType;
}

/** Regex matching @[Label](id:type) in markdown */
const MENTION_MARKDOWN_RE = /@\[([^\]]+)\]\(([^:]+):([^)]+)\)/g;

/**
 * Parse markdown mention text into display text + tracked positions.
 *
 * "@[Alice](u1:user) hi @[Doc](p1:page)"
 * → { displayText: "@Alice hi @Doc", mentions: [{start:0,end:6,...}, {start:11,end:15,...}] }
 */
export function markdownToDisplay(markdown: string): {
  displayText: string;
  mentions: TrackedMention[];
} {
  const mentions: TrackedMention[] = [];
  let displayText = '';
  let lastIndex = 0;

  MENTION_MARKDOWN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = MENTION_MARKDOWN_RE.exec(markdown)) !== null) {
    const [fullMatch, label, id, type] = match;

    // Append text before this mention
    displayText += markdown.slice(lastIndex, match.index);

    const displayLabel = `@${label}`;
    const start = displayText.length;
    const end = start + displayLabel.length;

    mentions.push({ start, end, label, id, type: type as MentionType });
    displayText += displayLabel;

    lastIndex = match.index + fullMatch.length;
  }

  // Append remaining text
  displayText += markdown.slice(lastIndex);

  return { displayText, mentions };
}

/**
 * Reconstruct markdown from display text + tracked mentions.
 *
 * displayToMarkdown("@Alice hi @Doc", mentions) → "@[Alice](u1:user) hi @[Doc](p1:page)"
 */
export function displayToMarkdown(
  displayText: string,
  mentions: TrackedMention[]
): string {
  if (mentions.length === 0) return displayText;

  // Sort mentions by position to process left-to-right
  const sorted = [...mentions].sort((a, b) => a.start - b.start);
  let result = '';
  let lastIndex = 0;

  for (const mention of sorted) {
    // Append text before this mention
    result += displayText.slice(lastIndex, mention.start);
    // Append markdown format
    result += `@[${mention.label}](${mention.id}:${mention.type})`;
    lastIndex = mention.end;
  }

  // Append remaining text
  result += displayText.slice(lastIndex);

  return result;
}

/**
 * Find the changed region between two strings.
 * Returns the first differing index and the end indices in old/new.
 */
export function findEditRegion(
  oldText: string,
  newText: string
): { start: number; oldEnd: number; newEnd: number } {
  // Find first differing character from the start
  let start = 0;
  const minLen = Math.min(oldText.length, newText.length);
  while (start < minLen && oldText[start] === newText[start]) {
    start++;
  }

  // Find first differing character from the end
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldText[oldEnd - 1] === newText[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }

  return { start, oldEnd, newEnd };
}

/**
 * Update mention positions after a text edit, removing mentions
 * that overlap the edit region and shifting those that follow.
 */
export function updateMentionPositions(
  mentions: TrackedMention[],
  oldText: string,
  newText: string
): TrackedMention[] {
  const { start: editStart, oldEnd: editOldEnd, newEnd: editNewEnd } =
    findEditRegion(oldText, newText);

  // No change
  if (editStart === editOldEnd && editStart === editNewEnd) return mentions;

  const shift = editNewEnd - editOldEnd;
  const result: TrackedMention[] = [];

  for (const mention of mentions) {
    // Mention is entirely before the edit — keep as-is
    if (mention.end <= editStart) {
      result.push(mention);
      continue;
    }

    // Mention is entirely after the edit — shift
    if (mention.start >= editOldEnd) {
      result.push({
        ...mention,
        start: mention.start + shift,
        end: mention.end + shift,
      });
      continue;
    }

    // Mention overlaps the edit region — remove it (it's been modified by the user)
    // This covers: partial overlap from left, partial overlap from right, and edit within mention
  }

  return result;
}
