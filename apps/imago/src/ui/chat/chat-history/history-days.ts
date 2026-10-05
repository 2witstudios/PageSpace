// The chat history's day groups, by the viewer's own calendar.
//
// Unlike ui/time (UTC, so server and browser render the same text), these
// read local time: a chat sent at 11pm belongs to that evening, wherever the
// viewer is. The history only renders in the browser (its rows come from SWR
// after mount), so there is no server text to match. The labels are built by
// hand, not by Intl, so they read the same in every runtime and locale. There
// is no ambient clock: "now" is passed in.

import type { AgentConversation } from '../chat-model/chat';

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const dayMs = 86_400_000;

/** For a time that does not parse: it still belongs somewhere. */
const EARLIER = 'Earlier';

/** Local midnight of a time's day, as a UTC instant on the same calendar date (DST-free arithmetic). */
const calendarDay = (at: Date): number => Date.UTC(at.getFullYear(), at.getMonth(), at.getDate());

/** `Today`, `Yesterday`, else `Sep 18` (this year) or `Dec 31, 2025`, by the local calendar. */
export const historyDayLabel = (iso: string, now: Date): string => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return EARLIER;
  const behind = Math.round((calendarDay(now) - calendarDay(at)) / dayMs);
  // A clock behind the server's can read a chat as later than now; it is still today's.
  if (behind <= 0) return 'Today';
  if (behind === 1) return 'Yesterday';
  const date = `${months[at.getMonth()] ?? ''} ${at.getDate()}`;
  return at.getFullYear() === now.getFullYear() ? date : `${date}, ${at.getFullYear()}`;
};

/** Milliseconds from `now` to the viewer's next local midnight, when every label moves a day. */
export const untilNextDay = (now: Date): number =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();

export type HistoryDay = {
  /** Sentence case: Today, Yesterday, Sep 18. */
  readonly label: string;
  readonly conversations: readonly AgentConversation[];
};

/**
 * Conversations filed under the day they were last active, in the order
 * given (the route lists them most recent first), each day once.
 */
export const historyDays = (conversations: readonly AgentConversation[], now: Date): readonly HistoryDay[] => {
  const days = new Map<string, AgentConversation[]>();
  for (const conversation of conversations) {
    const label = historyDayLabel(conversation.updatedAt, now);
    const day = days.get(label);
    if (day === undefined) days.set(label, [conversation]);
    else day.push(conversation);
  }
  return [...days].map(([label, entries]) => ({ label, conversations: entries }));
};
