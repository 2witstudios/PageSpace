/**
 * Pure helpers that wire TasksDashboard filter state to useLayoutStore.
 */

import { describe, it, expect } from 'vitest';
import {
  scopeKeyFor,
  pickInitialFilters,
  toStoredDashboardFilters,
  fromStoredOrDefaults,
  forFocus,
  DEFAULT_DASHBOARD_FILTERS,
} from '../dashboardFiltersPersistence';
import type { StoredDashboardFilters } from '@/stores/useLayoutStore';

const params = (entries: Record<string, string>): URLSearchParams => new URLSearchParams(entries);

describe('scopeKeyFor', () => {
  it('given user context, should return "user"', () => {
    expect(scopeKeyFor('user', undefined)).toBe('user');
  });

  it('given drive context with driveId, should return "drive:<driveId>"', () => {
    expect(scopeKeyFor('drive', 'abc')).toBe('drive:abc');
  });

  it('given drive context with no driveId yet, should return "drive:" placeholder', () => {
    expect(scopeKeyFor('drive', undefined)).toBe('drive:');
  });
});

describe('pickInitialFilters', () => {
  it('given URL has any persistable param, should ignore stored prefs and use URL', () => {
    const stored: StoredDashboardFilters = { assigneeFilter: 'all', status: 'pending' };

    const result = pickInitialFilters(params({ status: 'in_progress' }), stored);

    expect(result.status).toBe('in_progress');
    expect(result.assigneeFilter).toBe('mine');
  });

  it('given URL has explicit status slug but no statusGroup, should default statusGroup to "all" so the API does not AND both filters', () => {
    const result = pickInitialFilters(params({ status: 'completed' }), undefined);

    expect(result.status).toBe('completed');
    expect(result.statusGroup).toBe('all');
  });

  it('given URL has any persistable param but no status, should still default statusGroup to "active"', () => {
    const result = pickInitialFilters(params({ priority: 'high' }), undefined);

    expect(result.statusGroup).toBe('active');
  });

  it('given URL has statusGroup param, should reflect that statusGroup value', () => {
    const result = pickInitialFilters(params({ statusGroup: 'completed' }), undefined);

    expect(result.statusGroup).toBe('completed');
  });

  it('given URL has invalid statusGroup value, should ignore it and fall back to default', () => {
    const result = pickInitialFilters(params({ statusGroup: 'bogus', priority: 'high' }), undefined);

    expect(result.statusGroup).toBe('active');
  });

  it('given URL is bare and stored prefs exist, should use stored prefs', () => {
    const stored: StoredDashboardFilters = {
      assigneeFilter: 'all',
      status: 'in_progress',
      dueDateFilter: 'overdue',
    };

    const result = pickInitialFilters(params({}), stored);

    expect(result.status).toBe('in_progress');
    expect(result.assigneeFilter).toBe('all');
    expect(result.dueDateFilter).toBe('overdue');
  });

  it('given URL bare and no stored prefs, should fall back to defaults', () => {
    const result = pickInitialFilters(params({}), undefined);

    expect(result).toEqual(DEFAULT_DASHBOARD_FILTERS);
  });

  it('given URL has only a driveId param, should not let it override stored preferences — the drive is the focus, not a filter', () => {
    const stored: StoredDashboardFilters = { assigneeFilter: 'all' };

    const result = pickInitialFilters(params({ driveId: 'd1' }), stored);

    expect(result).toEqual(fromStoredOrDefaults(stored));
  });

  it('given URL has only assigneeFilter=mine, should still treat as URL precedence (explicit)', () => {
    const stored: StoredDashboardFilters = { assigneeFilter: 'all' };

    const result = pickInitialFilters(params({ assigneeFilter: 'mine' }), stored);

    expect(result.assigneeFilter).toBe('mine');
  });
});

describe('fromStoredOrDefaults', () => {
  it('given undefined stored prefs, should return defaults', () => {
    expect(fromStoredOrDefaults(undefined)).toEqual(DEFAULT_DASHBOARD_FILTERS);
  });

  it('given partial stored prefs, should merge over defaults', () => {
    const result = fromStoredOrDefaults({ status: 'in_progress' });

    expect(result.status).toBe('in_progress');
    expect(result.assigneeFilter).toBe('mine');
    expect(result.statusGroup).toBe('active');
  });

  it('given stored prefs that override statusGroup, should respect the override', () => {
    const result = fromStoredOrDefaults({ statusGroup: 'all' });

    expect(result.statusGroup).toBe('all');
  });

  it('given stored prefs that override the default assignee, should respect the override', () => {
    const result = fromStoredOrDefaults({ assigneeFilter: 'all' });

    expect(result.assigneeFilter).toBe('all');
  });
});

describe('toStoredDashboardFilters', () => {
  it('given full ExtendedFilters, should retain only the persistable subset', () => {
    const result = toStoredDashboardFilters({
      status: 'pending',
      priority: 'high',
      search: 'budget',
      dueDateFilter: 'overdue',
      assigneeFilter: 'all',
      statusGroup: 'completed',
    });

    expect(result).toEqual({
      status: 'pending',
      priority: 'high',
      search: 'budget',
      dueDateFilter: 'overdue',
      assigneeFilter: 'all',
      statusGroup: 'completed',
    });
  });

  it('given undefined fields, should omit them from the stored shape', () => {
    const result = toStoredDashboardFilters({ assigneeFilter: 'mine' });

    expect(result).toEqual({ assigneeFilter: 'mine' });
  });
});

describe('pickInitialFilters across all drives', () => {
  it('given ?status= outside a drive, should ignore it and not widen the status group on its behalf', () => {
    const result = pickInitialFilters(new URLSearchParams('status=done&priority=high'), undefined, false);
    expect(result.status).toBeUndefined();
    expect(result.statusGroup).toBe('active');
    expect(result.priority).toBe('high');
  });

  it('given a URL carrying only keys this focus discards, should keep the stored preferences', () => {
    const stored = { assigneeFilter: 'all', statusGroup: 'completed', priority: 'high' } as const;
    expect(pickInitialFilters(new URLSearchParams('status=done'), stored, false)).toEqual(fromStoredOrDefaults(stored));
    expect(pickInitialFilters(new URLSearchParams('driveId=d1'), stored, true)).toEqual(fromStoredOrDefaults(stored));
  });

  it('given ?status= inside a drive, should read it and let the group fall to all', () => {
    const result = pickInitialFilters(new URLSearchParams('status=done'), undefined, true);
    expect(result.status).toBe('done');
    expect(result.statusGroup).toBe('all');
  });
});

describe('forFocus', () => {
  it('given a drive focus, should keep the slug status', () => {
    expect(forFocus({ status: 'in_progress', priority: 'high' }, true)).toEqual({
      status: 'in_progress',
      priority: 'high',
    });
  });

  it('given the All drives focus, should also drop the slug status the UI cannot show', () => {
    expect(forFocus({ status: 'in_progress', statusGroup: 'all', search: 'x' }, false)).toEqual({
      statusGroup: 'all',
      search: 'x',
    });
  });

  it('given nothing to drop, should return an equal object', () => {
    expect(forFocus({ priority: 'low', assigneeFilter: 'all' }, false)).toEqual({ priority: 'low', assigneeFilter: 'all' });
  });
});
