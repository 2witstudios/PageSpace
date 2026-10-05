/* Times are formatted by hand in UTC rather than by Intl, whose output
   (and spacing before AM/PM) varies by runtime, so the server and the
   browser render the same text. There is no ambient clock: "today" is
   passed in (myimago SHELL-8). */

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const dayMs = 86_400_000;

/** `9:12 AM`: a time of day, in UTC. */
export const formatTime = (iso: string): string => {
  const at = new Date(iso);
  const hours = at.getUTCHours();
  const minutes = String(at.getUTCMinutes()).padStart(2, '0');
  return `${hours % 12 || 12}:${minutes} ${hours < 12 ? 'AM' : 'PM'}`;
};

/** The UTC calendar day of an ISO time, as `YYYY-MM-DD`. */
export const dayOf = (iso: string): string => new Date(iso).toISOString().slice(0, 10);

/** The UTC calendar day an injected clock reads. */
export const todayOf = (now: Date): string => now.toISOString().slice(0, 10);

/** `Today`, `Yesterday`, else `Sep 18`, relative to `today` (YYYY-MM-DD). */
export const dayLabel = (iso: string, today: string): string => {
  const day = dayOf(iso);
  const behind = Math.round((Date.parse(today) - Date.parse(day)) / dayMs);
  if (behind === 0) return 'Today';
  if (behind === 1) return 'Yesterday';
  const at = new Date(day);
  return `${months[at.getUTCMonth()] ?? ''} ${at.getUTCDate()}`;
};
