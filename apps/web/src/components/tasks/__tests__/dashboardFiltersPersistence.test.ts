/**
 * Pure helpers that wire TasksDashboard filter state to useLayoutStore.
 */

import { describe, it, expect } from 'vitest';
import {
  scopeKeyFor,
  pickInitialFilters,
  toStoredDashboardFilters,
  fromStoredOrDefaults,
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

  it('given URL has driveId param, should treat that as a persistable param triggering URL precedence', () => {
    const stored: StoredDashboardFilters = { assigneeFilter: 'all' };

    const result = pickInitialFilters(params({ driveId: 'd1' }), stored);

    expect(result.driveId).toBe('d1');
    expect(result.assigneeFilter).toBe('mine');
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
      driveId: 'd1',
      search: 'budget',
      dueDateFilter: 'overdue',
      assigneeFilter: 'all',
    });

    expect(result).toEqual({
      status: 'pending',
      priority: 'high',
      search: 'budget',
      dueDateFilter: 'overdue',
      assigneeFilter: 'all',
    });
  });

  it('given undefined fields, should omit them from the stored shape', () => {
    const result = toStoredDashboardFilters({ assigneeFilter: 'mine' });

    expect(result).toEqual({ assigneeFilter: 'mine' });
  });
});
