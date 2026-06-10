import { describe, it, expect } from 'vitest';
import {
  filterAndRankCommands,
  resolveSelectionTarget,
  scopeBadgeLabel,
  scopeAnnouncement,
  shadowedTooltip,
  commandOptionAccessibleName,
  commandResultsAnnouncement,
  noMatchesCopy,
  NO_COMMANDS_EMPTY_STATE,
  CommandSuggestionItem,
} from '../command-picker-core';

const item = (overrides: Partial<CommandSuggestionItem>): CommandSuggestionItem => ({
  id: 'id',
  trigger: 'trigger',
  description: 'description',
  scope: 'user',
  ...overrides,
});

const list: CommandSuggestionItem[] = [
  item({ id: 'd1', trigger: 'zeta', scope: 'drive', description: 'drive zeta' }),
  item({ id: 'u1', trigger: 'release', scope: 'user', description: 'cut a release' }),
  item({ id: 'b1', trigger: 'help', scope: 'builtin', description: 'list commands' }),
  item({ id: 'u2', trigger: 'alpha', scope: 'user', description: 'first thing' }),
  item({ id: 'd2', trigger: 'beta', scope: 'drive', description: 'release notes helper' }),
];

describe('filterAndRankCommands', () => {
  it('given an empty query, should order builtin, personal, drive; alphabetical within scope', () => {
    const result = filterAndRankCommands(list, '');
    expect(result.map((r) => r.id)).toEqual(['b1', 'u2', 'u1', 'd2', 'd1']);
  });

  it('given a query, should rank trigger prefix matches first, then trigger substring, then description', () => {
    const result = filterAndRankCommands(list, 'rel');
    // 'release' = prefix; 'beta' matches via description 'release notes helper'
    expect(result.map((r) => r.id)).toEqual(['u1', 'd2']);
  });

  it('given a query matching mid-trigger, should rank it after prefix matches', () => {
    const items = [
      item({ id: 'a', trigger: 'release' }),
      item({ id: 'b', trigger: 'pre-release' }),
    ];
    expect(filterAndRankCommands(items, 'rel').map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('should match case-insensitively', () => {
    expect(filterAndRankCommands(list, 'RELEASE').map((r) => r.id)).toEqual(['u1', 'd2']);
  });

  it('given no matches, should return empty', () => {
    expect(filterAndRankCommands(list, 'zzz-nope')).toEqual([]);
  });

  it('should keep shadowed commands in filtered results', () => {
    const items = [
      item({ id: 'w', trigger: 'foo', scope: 'user' }),
      item({ id: 's', trigger: 'foo', scope: 'drive', shadowedBy: 'user' }),
    ];
    const result = filterAndRankCommands(items, 'foo');
    expect(result.map((r) => r.id)).toEqual(['w', 's']);
  });
});

describe('resolveSelectionTarget', () => {
  const winner = item({ id: 'w', trigger: 'foo', scope: 'user' });
  const shadowed = item({ id: 's', trigger: 'foo', scope: 'drive', shadowedBy: 'user' });

  it('given a non-shadowed row, should return it', () => {
    expect(resolveSelectionTarget([winner, shadowed], winner)).toBe(winner);
  });

  it('given a shadowed row, should return the winning command (precedence is never bypassed)', () => {
    expect(resolveSelectionTarget([winner, shadowed], shadowed)).toBe(winner);
  });

  it('given a shadowed row with no winner present, should fall back to the row itself', () => {
    expect(resolveSelectionTarget([shadowed], shadowed)).toBe(shadowed);
  });
});

describe('copy helpers', () => {
  it('maps scopes to badge labels', () => {
    expect(scopeBadgeLabel('builtin')).toBe('Built-in');
    expect(scopeBadgeLabel('user')).toBe('Personal');
    expect(scopeBadgeLabel('drive')).toBe('Drive');
  });

  it('maps scopes to screen-reader announcements', () => {
    expect(scopeAnnouncement('builtin')).toBe('built-in command');
    expect(scopeAnnouncement('user')).toBe('personal command');
    expect(scopeAnnouncement('drive')).toBe('drive command');
  });

  it('builds the shadowed tooltip naming the winning scope', () => {
    expect(shadowedTooltip(item({ trigger: 'foo', shadowedBy: 'user' }))).toBe(
      'Shadowed by your personal command /foo. The personal command runs instead.'
    );
    expect(shadowedTooltip(item({ trigger: 'foo', shadowedBy: 'builtin' }))).toBe(
      'Shadowed by the built-in command /foo. The built-in command runs instead.'
    );
  });

  it('includes trigger, scope, shadow state, and description in the accessible name', () => {
    expect(
      commandOptionAccessibleName(
        item({ trigger: 'release-checklist', scope: 'drive', shadowedBy: 'user', description: 'ship it' })
      )
    ).toBe('/release-checklist, drive command, shadowed, ship it');

    expect(
      commandOptionAccessibleName(item({ trigger: 'help', scope: 'builtin', description: 'list commands' }))
    ).toBe('/help, built-in command, list commands');
  });

  it('announces result counts politely', () => {
    expect(commandResultsAnnouncement(3)).toBe('3 commands available');
    expect(commandResultsAnnouncement(1)).toBe('1 command available');
    expect(commandResultsAnnouncement(0)).toBe('No commands match');
  });

  it('renders the no-match empty state with the query', () => {
    expect(noMatchesCopy('xyz')).toBe('No commands match “xyz”');
  });

  it('exposes the no-commands-yet empty state copy', () => {
    expect(NO_COMMANDS_EMPTY_STATE).toBe(
      'No commands yet. Create one in Settings → AI Settings → Commands.'
    );
  });
});
