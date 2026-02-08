import { useRef, useCallback, useMemo } from 'react';
import { MentionType } from '@/types/mentions';

export interface TrackedMention {
  start: number;
  end: number;
  label: string;
  id: string;
  type: MentionType;
}

const MENTION_REGEX = /@\[([^\]]+)\]\(([^:]+):([^)]+)\)/g;

/**
 * Parse markdown-typed mention format into display text and tracked positions.
 *
 * Input:  "Hello @[Alice](user123:user) world"
 * Output: { displayText: "Hello @Alice world", mentions: [{start:6, end:12, ...}] }
 */
export function markdownToDisplay(markdown: string): {
  displayText: string;
  mentions: TrackedMention[];
} {
  const mentions: TrackedMention[] = [];
  let displayText = '';
  let lastIndex = 0;

  MENTION_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = MENTION_REGEX.exec(markdown)) !== null) {
    const [fullMatch, label, id, type] = match;

    displayText += markdown.slice(lastIndex, match.index);

    const mentionStart = displayText.length;
    const displayMention = `@${label}`;
    displayText += displayMention;

    mentions.push({
      start: mentionStart,
      end: mentionStart + displayMention.length,
      label,
      id,
      type: type as MentionType,
    });

    lastIndex = match.index + fullMatch.length;
  }

  displayText += markdown.slice(lastIndex);

  return { displayText, mentions };
}

/**
 * Convert display text + tracked mentions back to markdown-typed format.
 *
 * Input:  "Hello @Alice world", [{start:6, end:12, label:"Alice", id:"user123", type:"user"}]
 * Output: "Hello @[Alice](user123:user) world"
 */
export function displayToMarkdown(
  displayText: string,
  mentions: TrackedMention[]
): string {
  if (mentions.length === 0) return displayText;

  const sorted = [...mentions].sort((a, b) => a.start - b.start);

  let markdown = '';
  let lastIndex = 0;

  for (const mention of sorted) {
    markdown += displayText.slice(lastIndex, mention.start);
    markdown += `@[${mention.label}](${mention.id}:${mention.type})`;
    lastIndex = mention.end;
  }

  markdown += displayText.slice(lastIndex);

  return markdown;
}

/**
 * Find the edit region between old and new text.
 * Returns the range in old text that was replaced and the corresponding range in new text.
 */
function findEditRegion(
  oldText: string,
  newText: string
): { start: number; oldEnd: number; newEnd: number } {
  let start = 0;
  while (
    start < oldText.length &&
    start < newText.length &&
    oldText[start] === newText[start]
  ) {
    start++;
  }

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
 * Update mention positions after a text edit.
 * Removes mentions that overlap the edited region and shifts those after it.
 */
function updateMentionPositions(
  mentions: TrackedMention[],
  oldText: string,
  newText: string
): TrackedMention[] {
  if (mentions.length === 0) return [];

  const { start, oldEnd, newEnd } = findEditRegion(oldText, newText);
  const delta = (newEnd - start) - (oldEnd - start);

  return mentions
    .filter((m) => {
      // Remove mentions that overlap with the edited region in old text
      return !(m.start < oldEnd && m.end > start);
    })
    .map((m) => {
      if (m.start >= oldEnd) {
        // Shift mentions after the edit
        return { ...m, start: m.start + delta, end: m.end + delta };
      }
      return m;
    });
}

export interface UseMentionTrackerResult {
  /** Display text shown in the textarea (no IDs) */
  displayText: string;
  /** Tracked mention positions in the display text */
  mentions: TrackedMention[];
  /** Whether any mentions exist */
  hasMentions: boolean;
  /** Handle textarea text changes — updates positions and reports markdown to parent */
  handleDisplayTextChange: (newDisplayText: string) => void;
  /** Register a newly inserted mention (call before handleDisplayTextChange) */
  registerMention: (mention: TrackedMention) => void;
}

/**
 * Manages the bidirectional conversion between markdown mention format
 * (used by parent/API) and display text (shown in the textarea).
 *
 * The parent passes markdown like "Hello @[Alice](user123:user) world"
 * and this hook converts it to display text "Hello @Alice world" for the textarea,
 * while tracking mention positions to reconstruct the markdown on changes.
 */
export function useMentionTracker(
  markdownValue: string,
  onMarkdownChange: (markdown: string) => void
): UseMentionTrackerResult {
  const displayTextRef = useRef('');
  const mentionsRef = useRef<TrackedMention[]>([]);
  const lastReportedMarkdownRef = useRef('');
  const pendingMentionsRef = useRef<TrackedMention[]>([]);

  // Parse markdown -> display text when value changes externally
  const { displayText, mentions } = useMemo(() => {
    // Skip re-parse if this value came from our own onChange
    if (markdownValue === lastReportedMarkdownRef.current) {
      return {
        displayText: displayTextRef.current,
        mentions: mentionsRef.current,
      };
    }

    const parsed = markdownToDisplay(markdownValue);
    displayTextRef.current = parsed.displayText;
    mentionsRef.current = parsed.mentions;
    return parsed;
  }, [markdownValue]);

  const registerMention = useCallback((mention: TrackedMention) => {
    pendingMentionsRef.current.push(mention);
  }, []);

  const handleDisplayTextChange = useCallback(
    (newDisplayText: string) => {
      const oldDisplayText = displayTextRef.current;

      // Update existing mention positions based on the text diff
      const updatedMentions = updateMentionPositions(
        mentionsRef.current,
        oldDisplayText,
        newDisplayText
      );

      // Merge in pending mentions from suggestion selection
      const allMentions = [...updatedMentions, ...pendingMentionsRef.current];
      pendingMentionsRef.current = [];

      // Sort by position
      allMentions.sort((a, b) => a.start - b.start);

      // Validate mention text still matches (safety check)
      const validMentions = allMentions.filter((m) => {
        const textAtPosition = newDisplayText.slice(m.start, m.end);
        return textAtPosition === `@${m.label}`;
      });

      displayTextRef.current = newDisplayText;
      mentionsRef.current = validMentions;

      // Convert to markdown and notify parent
      const markdown = displayToMarkdown(newDisplayText, validMentions);
      lastReportedMarkdownRef.current = markdown;
      onMarkdownChange(markdown);
    },
    [onMarkdownChange]
  );

  return {
    displayText,
    mentions,
    hasMentions: mentions.length > 0,
    handleDisplayTextChange,
    registerMention,
  };
}
