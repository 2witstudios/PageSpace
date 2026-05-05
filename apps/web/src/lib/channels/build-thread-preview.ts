/**
 * Truncate channel/DM message content for inbox + thread previews.
 *
 * Centralized so the channel POST route, the agent mention responder, and any
 * future callers all surface the same shape (100-char ellipsis). Keeping this
 * in one place means a future change (e.g. grapheme-aware truncation) lands
 * once and propagates.
 */
export function buildThreadPreview(content: string, limit = 100): string {
  return content.length > limit ? content.substring(0, limit) + '...' : content;
}
