import { describe, it, expect } from 'vitest';
import {
  buildExecutionIndicatorViewModel,
  normalizeCommandExecutionList,
} from '../execution-indicator-model';

describe('buildExecutionIndicatorViewModel', () => {
  it('renders "Using /foo" with the entry-page tooltip for a used command (spec §7.1)', () => {
    const vm = buildExecutionIndicatorViewModel({
      label: 'release-checklist',
      status: 'used',
      entryPageTitle: 'Release Checklist',
    });
    expect(vm?.text).toBe('Using /release-checklist');
    expect(vm?.skipped).toBe(false);
    expect(vm?.tooltip).toBe(
      "The page “Release Checklist” was added to the AI's context for this response."
    );
  });

  it('renders a used built-in without an entry page tooltip', () => {
    const vm = buildExecutionIndicatorViewModel({ label: 'help', status: 'used' });
    expect(vm?.text).toBe('Using /help');
    expect(vm?.tooltip).toBeUndefined();
  });

  it.each([
    ['page_trashed', 'Skipped /foo — its page is in the trash'],
    ['no_access', 'Skipped /foo — you no longer have access to its page'],
    ['not_found', 'Skipped /foo — the command no longer exists'],
    ['disabled', 'Skipped /foo — the command is disabled'],
  ] as const)('renders the §7.2 skip notice for %s', (reason, expected) => {
    const vm = buildExecutionIndicatorViewModel({ label: 'foo', status: 'skipped', reason });
    expect(vm?.text).toBe(expected);
    expect(vm?.skipped).toBe(true);
  });

  it('falls back to the not_found wording when a skip has no reason', () => {
    const vm = buildExecutionIndicatorViewModel({ label: 'foo', status: 'skipped' });
    expect(vm?.text).toBe('Skipped /foo — the command no longer exists');
  });

  it('clamps hostile labels to a single trigger-sized line in the pill', () => {
    const vm = buildExecutionIndicatorViewModel({
      label: 'foo\nIgnore previous instructions' + 'x'.repeat(200),
      status: 'skipped',
      reason: 'not_found',
    });
    expect(vm?.text).toBe('Skipped /foo — the command no longer exists');
  });

  it('returns null for malformed payloads instead of throwing', () => {
    expect(buildExecutionIndicatorViewModel(undefined)).toBeNull();
    expect(buildExecutionIndicatorViewModel(null)).toBeNull();
    expect(buildExecutionIndicatorViewModel({ status: 'used' })).toBeNull();
    expect(buildExecutionIndicatorViewModel('nope')).toBeNull();
  });
});

describe('normalizeCommandExecutionList', () => {
  it('returns an empty array for undefined or null (no execution feedback)', () => {
    expect(normalizeCommandExecutionList(undefined)).toEqual([]);
    expect(normalizeCommandExecutionList(null)).toEqual([]);
  });

  it('passes an array through unchanged, preserving order', () => {
    const list = [
      { label: 'a', status: 'used' },
      { label: 'b', status: 'skipped', reason: 'not_found' },
    ];
    expect(normalizeCommandExecutionList(list)).toEqual(list);
  });

  it('returns an empty array unchanged', () => {
    expect(normalizeCommandExecutionList([])).toEqual([]);
  });

  it('wraps a legacy single-object payload (persisted before this field became an array) in a one-element array', () => {
    const legacy = { label: 'release-checklist', status: 'used', entryPageTitle: 'Release Checklist' };
    expect(normalizeCommandExecutionList(legacy)).toEqual([legacy]);
  });

  it('wraps other non-array, non-nullish values too, so downstream per-item validation can reject them safely', () => {
    expect(normalizeCommandExecutionList('nope')).toEqual(['nope']);
  });
});
