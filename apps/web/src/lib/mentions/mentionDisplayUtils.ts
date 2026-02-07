/**
 * Mention Display Utilities
 *
 * Converts between the raw mention format stored in state (@[Label](id:type))
 * and the display format shown in the textarea (@Label).
 *
 * The raw format encodes the page/user ID so the backend can process mentions,
 * but the extra characters create visible empty space in the input. These
 * utilities keep the ID metadata out of the textarea while preserving it for
 * submission.
 */

export interface MentionData {
  label: string;
  id: string;
  type: string;
}

const MENTION_REGEX = /@\[([^\]]+)\]\(([^:]+):([^)]+)\)/g;

/**
 * Extract structured mention data from a raw value containing @[Label](id:type).
 */
export function extractMentions(rawValue: string): MentionData[] {
  const mentions: MentionData[] = [];
  MENTION_REGEX.lastIndex = 0;
  let match;
  while ((match = MENTION_REGEX.exec(rawValue)) !== null) {
    mentions.push({ label: match[1], id: match[2], type: match[3] });
  }
  return mentions;
}

/**
 * Strip mention IDs to produce the user-facing display value.
 *
 * "@[My Page](abc:page) hi" → "@My Page hi"
 */
export function toDisplayValue(rawValue: string): string {
  return rawValue.replace(MENTION_REGEX, '@$1');
}

/**
 * Reconstruct the raw value by re-injecting mention IDs into display text.
 *
 * Mentions are matched in order: the first occurrence of @Label maps to the
 * first mention entry, the second to the second, etc.  This handles the
 * (uncommon) case of two mentions sharing the same label.
 */
export function toRawValue(
  displayValue: string,
  mentions: MentionData[]
): string {
  let result = displayValue;
  let offset = 0;

  for (const mention of mentions) {
    const displayPattern = `@${mention.label}`;
    const rawPattern = `@[${mention.label}](${mention.id}:${mention.type})`;

    const idx = result.indexOf(displayPattern, offset);
    if (idx !== -1) {
      result =
        result.substring(0, idx) +
        rawPattern +
        result.substring(idx + displayPattern.length);
      offset = idx + rawPattern.length;
    }
    // If the label isn't found the mention was deleted — skip it.
  }

  return result;
}
