/**
 * Types for the Home "signal line" — the single line of true, permission-scoped
 * facts shown above the composer on the Global Assistant home screen.
 *
 * A Signal is a candidate fact ("Sarah mentioned you", "3 tasks due today").
 * The pulse route computes zero or more Signals per user; `composeLine`
 * (composer.ts, next leaf) filters, ranks and renders them into one line.
 *
 * Persona is never asked or stored: a signal with `count === 0` is dropped
 * before ranking, so a solo user, a founder and a team member in a large org
 * each see a different line purely from which signals are non-zero.
 */

/**
 * Fixed kinds, in the epic's priority order (highest priority first). The
 * numeric values in {@link SIGNAL_PRIORITY} are derived from this array's
 * order, so reordering this array is how priority changes — never edit
 * `SIGNAL_PRIORITY` directly.
 */
export const SIGNAL_KINDS = [
  'mention',
  'overdue_task',
  'pending_invite',
  'agent_finished',
  'due_today',
  'unread_dm',
  'pages_changed',
  'left_off',
  'meeting_today',
  'pulse_summary',
] as const;

export type SignalKind = (typeof SIGNAL_KINDS)[number];

/** `SignalKind -> priority`, lower number = higher priority (shown first). */
export const SIGNAL_PRIORITY: Readonly<Record<SignalKind, number>> = Object.freeze(
  Object.fromEntries(SIGNAL_KINDS.map((kind, index) => [kind, index])) as Record<SignalKind, number>,
);

/** What a signal is about, when it concerns exactly one thing (count === 1). */
export interface SignalSubject {
  type: 'user' | 'page' | 'drive' | 'session';
  id: string;
  title: string;
}

/** The window of time a signal's count was computed over. */
export interface SignalWindow {
  /** Start of the window. */
  since: Date;
  /**
   * `'today'` for the normal case; `'since_last_visit'` when the user's last
   * visit is more than 3 days old, so every signal on the line uses the same
   * "since you were last here" framing instead of "today".
   */
  kind: 'today' | 'since_last_visit';
}

/** Two lengths of the same fact, so the line can shorten before it wraps. */
export interface SignalText {
  /** Full phrasing, used when this signal leads the line. */
  lead: string;
  /** Compact phrasing, used when this signal trails the line. */
  short: string;
}

/** What clicking this signal's suggestion does. Exactly one of the two, or neither. */
export interface SignalAction {
  /** Seeds the composer with this prompt (not sent). */
  prompt?: string;
  /** Navigates instead of prompting (e.g. "where you left off"). */
  href?: string;
}

/** One candidate fact for the home line. */
export interface Signal {
  kind: SignalKind;
  /**
   * How many things this signal represents. `0` means the signal is dropped
   * before ranking — it must never be rendered as "0 mentions".
   */
  count: number;
  /** Present only when `count === 1` and the fact is about one specific thing. */
  subject?: SignalSubject;
  window: SignalWindow;
  /** When this signal's count was computed; used to drop stale signals. */
  computedAt: Date;
  text: SignalText;
  action: SignalAction;
}

/**
 * Per-user context `composeLine` needs alongside the signal list: the
 * greeting name, how many drives they can see, and how long since they were
 * last here (drives `SignalWindow.kind` and the "Welcome back" greeting).
 */
export interface HomeContext {
  userId: string;
  /** First name (or display name) for the greeting. */
  displayName: string;
  timezone: string;
  /** All drive ids the user can currently access. */
  driveIds: string[];
  /** Distinct drive ids from the user's recent page-view history. */
  drivesInUse: string[];
  /** `max(viewedAt)` across the user's page views before this session, or `null`. */
  lastVisitAt: Date | null;
  pulseEnabled: boolean;
}
