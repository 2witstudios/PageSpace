/**
 * Error resolution workflow (#890 Phase 3 leaf 3).
 *
 * error_logs rows move to immutable ClickHouse post-cutover, so the mutable
 * resolved-flag workflow lives in the error_resolutions mini-table in main
 * PG, keyed by the error row's stable id. The two stores are NEVER
 * SQL-joined: readers fetch error rows (CH or PG), fetch resolutions by id
 * from PG, and merge in app code. These tests pin the pure merge/normalize
 * logic and the two-step composition; the PG store shell is exercised by the
 * app-level parity integration tests.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  mergeErrorResolutions,
  normalizeResolutionInput,
  createErrorResolutionReader,
  type ErrorResolutionRecord,
} from '../error-resolutions';

const NOW = new Date('2026-07-10T00:00:00.000Z');

const resolution = (overrides?: Partial<ErrorResolutionRecord>): ErrorResolutionRecord => ({
  errorId: 'e1',
  resolved: true,
  resolvedAt: NOW,
  resolvedBy: 'admin-1',
  resolution: 'fixed upstream',
  ...overrides,
});

describe('mergeErrorResolutions', () => {
  it('given a resolution for an error id, should attach its fields to that error', () => {
    const merged = mergeErrorResolutions(
      [{ id: 'e1', message: 'boom' }, { id: 'e2', message: 'bang' }],
      [resolution()],
    );
    expect(merged).toEqual([
      {
        id: 'e1',
        message: 'boom',
        resolved: true,
        resolvedAt: NOW,
        resolvedBy: 'admin-1',
        resolution: 'fixed upstream',
      },
      {
        id: 'e2',
        message: 'bang',
        resolved: false,
        resolvedAt: null,
        resolvedBy: null,
        resolution: null,
      },
    ]);
  });

  it('given a resolution row whose id matches no error, should ignore it', () => {
    const merged = mergeErrorResolutions([{ id: 'e2' }], [resolution({ errorId: 'ghost' })]);
    expect(merged).toEqual([
      { id: 'e2', resolved: false, resolvedAt: null, resolvedBy: null, resolution: null },
    ]);
  });

  it('given a reopened resolution (resolved=false), should carry it through, not default it', () => {
    const merged = mergeErrorResolutions(
      [{ id: 'e1' }],
      [resolution({ resolved: false, resolution: 'reopened: still happening' })],
    );
    expect(merged[0].resolved).toBe(false);
    expect(merged[0].resolution).toBe('reopened: still happening');
    expect(merged[0].resolvedAt).toEqual(NOW);
  });
});

describe('normalizeResolutionInput', () => {
  it('given only an errorId, should default to resolved=true with null attribution', () => {
    expect(normalizeResolutionInput({ errorId: 'e1' }, NOW)).toEqual({
      errorId: 'e1',
      resolved: true,
      resolvedAt: NOW,
      resolvedBy: null,
      resolution: null,
    });
  });

  it('given explicit fields, should keep them (including resolved=false reopen)', () => {
    expect(
      normalizeResolutionInput(
        { errorId: 'e1', resolved: false, resolvedBy: 'admin-1', resolution: 'not fixed' },
        NOW,
      ),
    ).toEqual({
      errorId: 'e1',
      resolved: false,
      resolvedAt: NOW,
      resolvedBy: 'admin-1',
      resolution: 'not fixed',
    });
  });
});

describe('createErrorResolutionReader', () => {
  it('given errors from the error store, should fetch resolutions for exactly those ids and merge', async () => {
    const errors = [
      { id: 'e1', message: 'boom' },
      { id: 'e2', message: 'bang' },
    ];
    const fetchErrors = vi.fn(async () => errors);
    const fetchResolutions = vi.fn(async () => [resolution()]);
    const reader = createErrorResolutionReader({ fetchErrors, fetchResolutions });

    const merged = await reader({ startDate: NOW }, 20);

    expect(fetchErrors).toHaveBeenCalledWith({ startDate: NOW }, 20);
    expect(fetchResolutions).toHaveBeenCalledWith(['e1', 'e2']);
    expect(merged[0].resolved).toBe(true);
    expect(merged[1].resolved).toBe(false);
  });

  it('given no errors in the window, should not query resolutions at all', async () => {
    const fetchErrors = vi.fn(async () => []);
    const fetchResolutions = vi.fn(async () => []);
    const reader = createErrorResolutionReader({ fetchErrors, fetchResolutions });

    expect(await reader({}, 20)).toEqual([]);
    expect(fetchResolutions).not.toHaveBeenCalled();
  });
});
