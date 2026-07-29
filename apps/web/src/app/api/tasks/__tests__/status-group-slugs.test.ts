import { describe, it, expect } from 'vitest';
import { groupTaskListsByAllowedStatusSlugs } from '../status-group-slugs';
import type { TaskListStatusConfigEntry } from '../status-group-slugs';

// ============================================================================
// Pure grouping of task lists by their allowed status slugs for a requested
// status group. This is the functional core of the /api/tasks statusGroup
// filter: N task lists collapse into K conditions, one per DISTINCT slug set
// — never one per task list (the 2026-07-28 Postgres OOM).
// ============================================================================

// DEFAULT_STATUS_CONFIG groups: pending → todo, in_progress → in_progress,
// blocked → in_progress, completed → done.
const DEFAULT_ACTIVE_SLUGS = ['blocked', 'in_progress', 'pending'];
const DEFAULT_DONE_SLUGS = ['completed'];

const configs = (entries: Array<[string, TaskListStatusConfigEntry[]]>) =>
  new Map<string, TaskListStatusConfigEntry[]>(entries);

describe('groupTaskListsByAllowedStatusSlugs', () => {
  it('groups all default-config lists under the default todo+in_progress slugs for statusGroup=active', () => {
    const result = groupTaskListsByAllowedStatusSlugs(
      ['list_a', 'list_b', 'list_c'],
      configs([]),
      'active',
    );

    expect(result).toHaveLength(1);
    expect(result[0].slugs).toEqual(DEFAULT_ACTIVE_SLUGS);
    expect(result[0].listPageIds).toEqual(['list_a', 'list_b', 'list_c']);
  });

  it('merges custom-config lists whose slug sets are identical, regardless of config order', () => {
    const result = groupTaskListsByAllowedStatusSlugs(
      ['list_a', 'list_b'],
      configs([
        ['list_a', [
          { slug: 'open', group: 'todo' },
          { slug: 'doing', group: 'in_progress' },
        ]],
        ['list_b', [
          { slug: 'doing', group: 'in_progress' },
          { slug: 'open', group: 'todo' },
        ]],
      ]),
      'active',
    );

    expect(result).toHaveLength(1);
    expect(result[0].slugs).toEqual(['doing', 'open']);
    expect(result[0].listPageIds).toEqual(['list_a', 'list_b']);
  });

  it('excludes a list whose custom config yields zero slugs for the requested group', () => {
    const result = groupTaskListsByAllowedStatusSlugs(
      ['list_done_only', 'list_default'],
      configs([
        // Only done-group statuses — nothing qualifies for 'active'.
        ['list_done_only', [{ slug: 'shipped', group: 'done' }]],
      ]),
      'active',
    );

    expect(result).toHaveLength(1);
    expect(result[0].listPageIds).toEqual(['list_default']);
    expect(result.every(g => !g.listPageIds.includes('list_done_only'))).toBe(true);
  });

  it('returns exactly K groups whose listPageIds partition the includable lists', () => {
    const result = groupTaskListsByAllowedStatusSlugs(
      ['list_a', 'list_b', 'list_c', 'list_d', 'list_e'],
      configs([
        ['list_b', [{ slug: 'open', group: 'todo' }]],
        ['list_d', [{ slug: 'open', group: 'todo' }]],
        ['list_e', [{ slug: 'triage', group: 'todo' }, { slug: 'doing', group: 'in_progress' }]],
      ]),
      'active',
    );

    // 3 distinct sets: default (a, c), {open} (b, d), {doing, triage} (e)
    expect(result).toHaveLength(3);
    const allIds = result.flatMap(g => g.listPageIds).sort();
    expect(allIds).toEqual(['list_a', 'list_b', 'list_c', 'list_d', 'list_e']);
    expect(result.find(g => g.slugs.join(',') === 'open')?.listPageIds).toEqual(['list_b', 'list_d']);
    expect(result.find(g => g.slugs.join(',') === 'doing,triage')?.listPageIds).toEqual(['list_e']);
    expect(result.find(g => g.slugs.join(',') === DEFAULT_ACTIVE_SLUGS.join(','))?.listPageIds)
      .toEqual(['list_a', 'list_c']);
  });

  it('uses the done-group slugs (custom or default) per list for statusGroup=completed', () => {
    const result = groupTaskListsByAllowedStatusSlugs(
      ['list_custom', 'list_default'],
      configs([
        ['list_custom', [
          { slug: 'shipped', group: 'done' },
          { slug: 'doing', group: 'in_progress' },
        ]],
      ]),
      'completed',
    );

    expect(result).toHaveLength(2);
    expect(result.find(g => g.listPageIds.includes('list_custom'))?.slugs).toEqual(['shipped']);
    expect(result.find(g => g.listPageIds.includes('list_default'))?.slugs).toEqual(DEFAULT_DONE_SLUGS);
  });

  it('returns no groups for an empty task list id array', () => {
    expect(groupTaskListsByAllowedStatusSlugs([], configs([]), 'active')).toEqual([]);
  });

  it('treats an empty custom config array as no custom config (defaults apply)', () => {
    const result = groupTaskListsByAllowedStatusSlugs(
      ['list_a'],
      configs([['list_a', []]]),
      'active',
    );

    expect(result).toHaveLength(1);
    expect(result[0].slugs).toEqual(DEFAULT_ACTIVE_SLUGS);
  });

  it('dedupes repeated slugs within a list config', () => {
    const result = groupTaskListsByAllowedStatusSlugs(
      ['list_a'],
      configs([
        ['list_a', [
          { slug: 'open', group: 'todo' },
          { slug: 'open', group: 'in_progress' },
        ]],
      ]),
      'active',
    );

    expect(result).toHaveLength(1);
    expect(result[0].slugs).toEqual(['open']);
  });

  it('does not collide slug sets whose joined text is identical (separator-safe key)', () => {
    // ['a b'] and ['a', 'b'] would collide under a space-joined key; the
    // grouping key must treat them as distinct sets.
    const result = groupTaskListsByAllowedStatusSlugs(
      ['list_one', 'list_two'],
      configs([
        ['list_one', [{ slug: 'a b', group: 'todo' }]],
        ['list_two', [{ slug: 'a', group: 'todo' }, { slug: 'b', group: 'todo' }]],
      ]),
      'active',
    );

    expect(result).toHaveLength(2);
    expect(result.find(g => g.listPageIds.includes('list_one'))?.slugs).toEqual(['a b']);
    expect(result.find(g => g.listPageIds.includes('list_two'))?.slugs).toEqual(['a', 'b']);
  });

  it('merges a custom config whose slug set equals the defaults with default-config lists', () => {
    const result = groupTaskListsByAllowedStatusSlugs(
      ['list_custom', 'list_default'],
      configs([
        ['list_custom', [
          { slug: 'pending', group: 'todo' },
          { slug: 'in_progress', group: 'in_progress' },
          { slug: 'blocked', group: 'in_progress' },
        ]],
      ]),
      'active',
    );

    expect(result).toHaveLength(1);
    expect(result[0].slugs).toEqual(DEFAULT_ACTIVE_SLUGS);
    expect(result[0].listPageIds).toEqual(['list_custom', 'list_default']);
  });
});
