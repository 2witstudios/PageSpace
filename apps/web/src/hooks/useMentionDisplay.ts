import { useCallback, useRef, useMemo } from 'react';
import {
  extractMentions,
  toDisplayValue,
  toRawValue,
  type MentionData,
} from '@/lib/mentions/mentionDisplayUtils';

export interface UseMentionDisplayOptions {
  /** Raw value from parent state (may contain @[Label](id:type)) */
  value: string;
  /** Callback that receives the raw value (with IDs re-injected) */
  onChange: (rawValue: string) => void;
}

export interface UseMentionDisplayResult {
  /** Value to show in the textarea (IDs stripped) */
  displayValue: string;
  /** Whether the display value contains any tracked mentions */
  hasMentions: boolean;
  /** Ordered mention data for the overlay */
  mentions: MentionData[];
  /** onChange wrapper — accepts the new *display* value from the textarea,
   *  reconstructs the raw value and forwards it to the parent onChange. */
  handleDisplayChange: (newDisplayValue: string) => void;
  /** Call this when a new mention is inserted via the suggestion picker.
   *  Must be invoked *before* the corresponding handleDisplayChange call
   *  so the new mention is available for reconstruction. */
  trackMention: (label: string, id: string, type: string) => void;
  /** Clear all tracked mentions (e.g. when the input is cleared). */
  clearMentions: () => void;
}

/**
 * Manages the bidirectional conversion between the raw mention format
 * (@[Label](id:type)) stored in parent state and the display format
 * (@Label) shown in the textarea.
 *
 * The parent always holds the raw format so the backend receives mention IDs.
 * The textarea shows only the label so there is no invisible spacing.
 */
export function useMentionDisplay({
  value,
  onChange,
}: UseMentionDisplayOptions): UseMentionDisplayResult {
  // Pending mentions that were just inserted but not yet in the parent value.
  // They are merged with existing mentions during the next handleDisplayChange.
  const pendingMentionsRef = useRef<MentionData[]>([]);

  // Derive the display value and mentions from the raw parent value.
  const displayValue = useMemo(() => toDisplayValue(value), [value]);
  const existingMentions = useMemo(() => extractMentions(value), [value]);
  const hasMentions = existingMentions.length > 0 || pendingMentionsRef.current.length > 0;

  const trackMention = useCallback(
    (label: string, id: string, type: string) => {
      pendingMentionsRef.current.push({ label, id, type });
    },
    []
  );

  const clearMentions = useCallback(() => {
    pendingMentionsRef.current = [];
  }, []);

  const handleDisplayChange = useCallback(
    (newDisplayValue: string) => {
      // Combine existing (from parent value) and freshly-inserted mentions.
      const allMentions = [...existingMentions, ...pendingMentionsRef.current];
      // Drain pending mentions — they will appear in existingMentions on the
      // next render once the parent value updates.
      pendingMentionsRef.current = [];
      const rawValue = toRawValue(newDisplayValue, allMentions);
      onChange(rawValue);
    },
    [existingMentions, onChange]
  );

  return {
    displayValue,
    hasMentions,
    mentions: existingMentions,
    handleDisplayChange,
    trackMention,
    clearMentions,
  };
}
