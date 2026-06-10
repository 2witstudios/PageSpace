import type { CommandScope } from '@pagespace/lib/commands/command-core';

/**
 * Pure presentation/filtering logic for the command picker (spec §1.4–§1.6, §9).
 * Components stay thin; everything rankable, announceable, or copy-exact lives
 * here under test.
 */

export interface CommandSuggestionItem {
  id: string;
  trigger: string;
  description: string;
  scope: CommandScope;
  /** Set on a precedence winner that hides a lower-precedence command. */
  shadows?: CommandScope;
  /** Set on a shadowed (losing) command: the scope of the command that wins. */
  shadowedBy?: CommandScope;
}

const SCOPE_ORDER: Record<CommandScope, number> = { builtin: 0, user: 1, drive: 2 };

/**
 * Filter + rank per spec §1.4: empty query lists everything ordered
 * builtin → personal → drive, alphabetical within scope. With a query,
 * trigger-prefix matches rank first, then trigger substring, then description
 * substring; all matching case-insensitively. Shadowed commands remain.
 */
export function filterAndRankCommands(
  items: readonly CommandSuggestionItem[],
  query: string
): CommandSuggestionItem[] {
  const q = query.trim().toLowerCase();

  const rankOf = (item: CommandSuggestionItem): number => {
    if (!q) return 0;
    const trigger = item.trigger.toLowerCase();
    if (trigger.startsWith(q)) return 0;
    if (trigger.includes(q)) return 1;
    if (item.description.toLowerCase().includes(q)) return 2;
    return 3;
  };

  return items
    .map((item) => ({ item, rank: rankOf(item) }))
    .filter(({ rank }) => rank < 3)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        SCOPE_ORDER[a.item.scope] - SCOPE_ORDER[b.item.scope] ||
        a.item.trigger.localeCompare(b.item.trigger)
    )
    .map(({ item }) => item);
}

/**
 * Resolution always follows precedence (spec §1.6): selecting a shadowed row
 * inserts the winning command's chip. Falls back to the row itself if no
 * winner is present (defensive — the API always sends the winner).
 */
export function resolveSelectionTarget(
  items: readonly CommandSuggestionItem[],
  selected: CommandSuggestionItem
): CommandSuggestionItem {
  if (!selected.shadowedBy) return selected;
  return (
    items.find((i) => i.trigger === selected.trigger && !i.shadowedBy) ?? selected
  );
}

export function scopeBadgeLabel(scope: CommandScope): string {
  switch (scope) {
    case 'builtin':
      return 'Built-in';
    case 'user':
      return 'Personal';
    case 'drive':
      return 'Drive';
  }
}

export function scopeAnnouncement(scope: CommandScope): string {
  switch (scope) {
    case 'builtin':
      return 'built-in command';
    case 'user':
      return 'personal command';
    case 'drive':
      return 'drive command';
  }
}

/** Possessive phrase for the scope that wins a shadowing collision. */
function shadowingScopePhrase(scope: CommandScope): string {
  switch (scope) {
    case 'builtin':
      return 'the built-in command';
    case 'user':
      return 'your personal command';
    case 'drive':
      return 'the drive command';
  }
}

/** Re-used inside the tooltip's second sentence ("The personal command runs instead."). */
function shadowingScopeNoun(scope: CommandScope): string {
  switch (scope) {
    case 'builtin':
      return 'built-in';
    case 'user':
      return 'personal';
    case 'drive':
      return 'drive';
  }
}

/** Tooltip for a shadowed row (spec §1.6). */
export function shadowedTooltip(item: CommandSuggestionItem): string {
  const winner = item.shadowedBy ?? 'builtin';
  return `Shadowed by ${shadowingScopePhrase(winner)} /${item.trigger}. The ${shadowingScopeNoun(winner)} command runs instead.`;
}

/**
 * Accessible name for an option: trigger, scope, shadow state, description
 * (spec §1.5/§9, e.g. "/release-checklist, drive command, shadowed").
 */
export function commandOptionAccessibleName(item: CommandSuggestionItem): string {
  const parts = [`/${item.trigger}`, scopeAnnouncement(item.scope)];
  if (item.shadowedBy) parts.push('shadowed');
  parts.push(item.description);
  return parts.join(', ');
}

/** Polite live-region announcement when results change (spec §9). */
export function commandResultsAnnouncement(count: number): string {
  if (count === 0) return 'No commands match';
  return `${count} command${count === 1 ? '' : 's'} available`;
}

/** Empty-state copy when a query has no matches (spec §1.4). */
export function noMatchesCopy(query: string): string {
  return `No commands match “${query}”`;
}

/** Empty-state copy when the user has no commands at all (spec §1.4). */
export const NO_COMMANDS_EMPTY_STATE =
  'No commands yet. Create one in Settings → AI Settings → Commands.';

/** Route the empty-state settings link navigates to. */
export const COMMANDS_SETTINGS_ROUTE = '/settings/commands';
