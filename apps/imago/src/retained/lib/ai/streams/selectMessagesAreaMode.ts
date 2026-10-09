/**
 * Decides whether a messages pane should show its loading skeleton or its
 * content (empty state / list / virtualized list — that further branch stays
 * the caller's concern).
 *
 * `isLoading` alone is not sufficient: a conversation switch, a background
 * refetch, or a rejoin-in-progress can all set `isLoading` true while the
 * previously-rendered messages (or a live stream) are still on screen. Gating
 * the skeleton on `isLoading` alone swapped the live list for a skeleton on
 * every one of those ticks — a list-to-skeleton flash. The skeleton is only
 * correct when there is truly nothing to show yet.
 *
 * Pure — no I/O, no side effects.
 */
export type MessagesAreaMode = 'skeleton' | 'content';

export const selectMessagesAreaMode = ({
  isLoading,
  messageCount,
  streamCount,
}: {
  isLoading: boolean;
  messageCount: number;
  streamCount: number;
}): MessagesAreaMode =>
  isLoading && messageCount === 0 && streamCount === 0 ? 'skeleton' : 'content';
