import { useCallback, useRef, useState } from 'react';
import {
  TrackedMention,
  markdownToDisplay,
  displayToMarkdown,
  updateMentionPositions,
} from '@/lib/mentions/mentionDisplayUtils';

export interface UseMentionTrackerResult {
  /** Display-only text (no IDs) for the textarea */
  displayText: string;
  /** Tracked mention positions in display text */
  mentions: TrackedMention[];
  /** Whether any mentions exist */
  hasMentions: boolean;
  /** Called when the textarea display text changes (user typing) */
  handleDisplayTextChange: (newDisplayText: string) => void;
  /** Register a newly inserted mention (called before handleDisplayTextChange) */
  registerMention: (mention: TrackedMention) => void;
}

/**
 * Manages bidirectional conversion between:
 * - Display text: "@Alice hi @Doc" (shown in textarea)
 * - Markdown text: "@[Alice](u1:user) hi @[Doc](p1:page)" (stored in parent state)
 *
 * Parses markdown → display when parent changes externally.
 * Reconstructs display → markdown when user types.
 */
export function useMentionTracker(
  value: string,
  onChange: (markdown: string) => void
): UseMentionTrackerResult {
  const [displayText, setDisplayText] = useState<string>(() => {
    const { displayText: dt } = markdownToDisplay(value);
    return dt;
  });
  const [mentions, setMentions] = useState<TrackedMention[]>(() => {
    const { mentions: m } = markdownToDisplay(value);
    return m;
  });

  // Refs for stable access in callbacks (avoid stale closures)
  const mentionsRef = useRef<TrackedMention[]>(mentions);
  mentionsRef.current = mentions;

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Track the last markdown we reported to parent, to skip re-parse on our own changes
  const lastReportedMarkdownRef = useRef<string>(value);
  // Track the previous value prop to detect external changes
  const prevValueRef = useRef<string>(value);
  // Track the last display text to diff against
  const lastDisplayTextRef = useRef<string>(displayText);
  // Queue for mentions about to be inserted
  const pendingMentionsRef = useRef<TrackedMention[]>([]);

  // Detect external value changes (parent changed value, not us)
  if (value !== prevValueRef.current) {
    prevValueRef.current = value;

    // Only re-parse if this change didn't come from our own onChange
    if (value !== lastReportedMarkdownRef.current) {
      const { displayText: newDisplay, mentions: newMentions } =
        markdownToDisplay(value);
      setDisplayText(newDisplay);
      setMentions(newMentions);
      mentionsRef.current = newMentions;
      lastDisplayTextRef.current = newDisplay;
      lastReportedMarkdownRef.current = value;
    }
  }

  const registerMention = useCallback((mention: TrackedMention) => {
    pendingMentionsRef.current.push(mention);
  }, []);

  const handleDisplayTextChange = useCallback(
    (newDisplayText: string) => {
      const oldDisplayText = lastDisplayTextRef.current;
      const currentMentions = mentionsRef.current;

      // Start with existing mentions, updated for the text edit
      let updatedMentions = updateMentionPositions(
        currentMentions,
        oldDisplayText,
        newDisplayText
      );

      // Merge any pending mentions (from suggestion insertion)
      if (pendingMentionsRef.current.length > 0) {
        updatedMentions = [...updatedMentions, ...pendingMentionsRef.current];
        updatedMentions.sort((a, b) => a.start - b.start);
        pendingMentionsRef.current = [];
      }

      // Validate: ensure each mention's text in displayText matches "@label"
      const validMentions = updatedMentions.filter((m) => {
        const slice = newDisplayText.slice(m.start, m.end);
        return slice === `@${m.label}`;
      });

      // Reconstruct markdown
      const markdown = displayToMarkdown(newDisplayText, validMentions);

      // Update state and refs synchronously
      setDisplayText(newDisplayText);
      setMentions(validMentions);
      mentionsRef.current = validMentions;
      lastDisplayTextRef.current = newDisplayText;
      lastReportedMarkdownRef.current = markdown;

      // Report to parent
      onChangeRef.current(markdown);
    },
    [] // stable — reads from refs
  );

  return {
    displayText,
    mentions,
    hasMentions: mentions.length > 0,
    handleDisplayTextChange,
    registerMention,
  };
}
