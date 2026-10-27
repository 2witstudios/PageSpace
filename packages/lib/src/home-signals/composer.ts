/**
 * Turns a list of {@link Signal}s into the one-line Home state: a greeting,
 * a lead icon, one line of text and up to three suggestions.
 *
 * Pure and synchronous — no I/O, no clock reads (the "now" a caller wants to
 * rank against is implicit in which signals it passed in and their
 * `computedAt`/`window`). This is what makes the persona fixture tests
 * (composer.test.ts) exhaustive: every persona is just a different Signal[].
 */
import { SIGNAL_PRIORITY, type HomeContext, type Signal } from './types';

/** Generic, always-safe suggestions used to fill slots no signal claimed. */
const GENERIC_SUGGESTIONS: readonly string[] = [
  'What changed this week?',
  'Plan today',
  'Draft a page',
];

/** Freshness window per kind, in milliseconds. A signal older than this is dropped. */
const SIGNAL_TTL_MS: Record<Signal['kind'], number> = {
  mention: 24 * 60 * 60 * 1000,
  overdue_task: 24 * 60 * 60 * 1000,
  pending_invite: 24 * 60 * 60 * 1000,
  agent_finished: 24 * 60 * 60 * 1000,
  due_today: 24 * 60 * 60 * 1000,
  unread_dm: 24 * 60 * 60 * 1000,
  pages_changed: 24 * 60 * 60 * 1000,
  left_off: 7 * 24 * 60 * 60 * 1000,
  meeting_today: 24 * 60 * 60 * 1000,
  // The LLM pulse summary already carries its own `isStale` (6h) upstream;
  // the caller should not even construct this signal once stale, but the
  // composer enforces the same bound defensively.
  pulse_summary: 6 * 60 * 60 * 1000,
};

/**
 * Icon name (lucide) shown next to the line, keyed by the lead signal's
 * kind. `as const satisfies` keeps this exhaustive over every SignalKind
 * (a missing kind is a compile error) while ALSO narrowing the values to a
 * literal union ({@link SignalIconName}) rather than plain `string` — the UI
 * layer's icon map (HomeLine.tsx's `ICONS`) is typed against that union, so
 * a value here with no matching UI icon is a compile error there too,
 * instead of silently rendering no icon at runtime.
 */
export const SIGNAL_ICON = {
  mention: 'at',
  overdue_task: 'alert-triangle',
  pending_invite: 'calendar',
  agent_finished: 'bot',
  due_today: 'check-square',
  unread_dm: 'message-square',
  pages_changed: 'file-text',
  left_off: 'file-text',
  meeting_today: 'calendar',
  pulse_summary: 'sparkles',
} as const satisfies Record<Signal['kind'], string>;

/** The literal set of icon names {@link SIGNAL_ICON} can produce. */
export type SignalIconName = (typeof SIGNAL_ICON)[Signal['kind']];

export interface ComposedLine {
  /** e.g. "Good morning, Jono." or "Welcome back, Jono." */
  greeting: string;
  /** The single leading fact, in normal (non-muted) weight. `null` on a quiet day. */
  lead: string | null;
  /** Trailing facts, muted, joined with " · " after the lead. */
  rest: string[];
  /** lucide icon name for the lead signal, or `null` when there is no lead (quiet day). */
  icon: SignalIconName | null;
  /** Up to three suggestion strings, signal-derived first, generic filler after. */
  suggestions: string[];
  /** The lead signal's `action.href`, when it navigates instead of prompting. */
  leadHref: string | null;
}

/** Below this, the line uses "since last visit" framing instead of "today". */
export const SINCE_LAST_VISIT_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;

const isFresh = (signal: Signal, asOf: Date): boolean =>
  asOf.getTime() - signal.computedAt.getTime() <= SIGNAL_TTL_MS[signal.kind];

/**
 * Drop zero-count and stale signals, then sort the survivors by the fixed
 * priority table. `asOf` defaults to `Date.now()` but is a parameter so
 * tests are deterministic.
 */
export function rankSignals(signals: readonly Signal[], asOf: Date = new Date()): Signal[] {
  return signals
    .filter((s) => s.count > 0 && isFresh(s, asOf))
    .slice()
    .sort((a, b) => SIGNAL_PRIORITY[a.kind] - SIGNAL_PRIORITY[b.kind]);
}

const greetingFor = (ctx: HomeContext, sinceLastVisit: boolean): string =>
  sinceLastVisit ? `Welcome back, ${ctx.displayName}.` : `Good morning, ${ctx.displayName}.`;

/** Fits `lead + rest` under `maxChars`: shortens trailing facts before dropping any. */
function fitToWidth(lead: string, rest: string[], maxChars: number): string[] {
  const fits = (parts: string[]) => [lead, ...parts].join(' · ').length <= maxChars;
  if (fits(rest)) return rest;

  // Pass 1: nothing to shorten further here — callers already pass `short`
  // text for `rest`. Pass 2: drop from the end until it fits, or nothing's left.
  let kept = rest.slice();
  while (kept.length > 0 && !fits(kept)) kept = kept.slice(0, -1);
  return kept;
}

export interface ComposeLineOptions {
  /** Max characters for `lead + rest` joined by " · ". Default fits one row at 600px / 14px. */
  maxChars?: number;
  asOf?: Date;
}

/**
 * The whole composition rule in one function: rank, cap at three, split into
 * lead/rest, fit to width, derive the greeting and suggestions, and fall
 * back to the quiet "all caught up" state when nothing survives.
 */
export function composeLine(
  signals: readonly Signal[],
  ctx: HomeContext,
  opts: ComposeLineOptions = {},
): ComposedLine {
  const asOf = opts.asOf ?? new Date();
  const maxChars = opts.maxChars ?? 88;
  const sinceLastVisit =
    ctx.lastVisitAt !== null && asOf.getTime() - ctx.lastVisitAt.getTime() > SINCE_LAST_VISIT_THRESHOLD_MS;
  const greeting = greetingFor(ctx, sinceLastVisit);

  const allRanked = rankSignals(signals, asOf);
  // The LLM pulse sentence decorates; it must never be the *only* content on
  // the line, and priority order already keeps it from ever leading when any
  // other signal survives. If nothing but pulse_summary survives, treat the
  // line as quiet rather than leading with generated prose alone.
  const ranked = allRanked.some((s) => s.kind !== 'pulse_summary') ? allRanked.slice(0, 3) : [];

  if (ranked.length === 0) {
    return {
      greeting,
      lead: `All caught up across ${ctx.driveIds.length} drive${ctx.driveIds.length === 1 ? '' : 's'}.`,
      rest: [],
      icon: null,
      suggestions: GENERIC_SUGGESTIONS.slice(0, 3),
      leadHref: null,
    };
  }

  const [leadSignal, ...restSignals] = ranked;
  const sincePrefix = sinceLastVisit
    ? `Since ${ctx.lastVisitAt!.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}: `
    : '';
  const lead = sincePrefix + leadSignal.text.lead;
  const restText = fitToWidth(lead, restSignals.map((s) => s.text.short), maxChars);

  const claimedPrompts = new Set<string>();
  const suggestions: string[] = [];
  for (const signal of ranked) {
    if (suggestions.length >= 3) break;
    const prompt = signal.action.prompt;
    if (prompt && !claimedPrompts.has(prompt)) {
      claimedPrompts.add(prompt);
      suggestions.push(prompt);
    }
  }
  for (const generic of GENERIC_SUGGESTIONS) {
    if (suggestions.length >= 3) break;
    if (!suggestions.includes(generic)) suggestions.push(generic);
  }

  return {
    greeting,
    lead,
    rest: restText,
    icon: SIGNAL_ICON[leadSignal.kind],
    suggestions,
    leadHref: leadSignal.action.href ?? null,
  };
}
