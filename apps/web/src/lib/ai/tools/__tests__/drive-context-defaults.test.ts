/**
 * Tests for apps/web/src/lib/ai/tools/drive-context-defaults.ts
 *
 * Covers the shared "default an omitted driveId tool argument" logic used by
 * create_page, list_pages, regex_search, glob_search and generate_image. Mirrors
 * page-context-defaults.test.ts — the two seams must not drift.
 */

import { describe, it, expect } from 'vitest';
import { resolveDefaultDriveId, resolveOrThrowDriveId } from '../drive-context-defaults';
import type { ToolExecutionContext } from '../../core/types';

const withCurrentDrive = (id: string) =>
  ({
    locationContext: { currentDrive: { id, name: 'Viewed', slug: 'viewed' } },
  }) as ToolExecutionContext;

describe('resolveDefaultDriveId', () => {
  it('prefers currentWorkingDrive over locationContext.currentDrive', () => {
    const context = {
      currentWorkingDrive: { id: 'working-drive' },
      locationContext: { currentDrive: { id: 'viewed-drive', name: 'Viewed', slug: 'viewed' } },
    } as ToolExecutionContext;
    expect(resolveDefaultDriveId(context)).toBe('working-drive');
  });

  it('falls back to locationContext.currentDrive.id when currentWorkingDrive is absent', () => {
    expect(resolveDefaultDriveId(withCurrentDrive('viewed-drive'))).toBe('viewed-drive');
  });

  it('returns undefined when neither is present', () => {
    expect(resolveDefaultDriveId({} as ToolExecutionContext)).toBeUndefined();
  });

  it('returns undefined when context itself is undefined', () => {
    expect(resolveDefaultDriveId(undefined)).toBeUndefined();
  });
});

describe('resolveOrThrowDriveId', () => {
  it('returns the explicit driveId argument when provided, ignoring context', () => {
    const context = { currentWorkingDrive: { id: 'working-drive' } } as ToolExecutionContext;
    expect(resolveOrThrowDriveId('explicit-drive', context)).toBe('explicit-drive');
  });

  it('falls back to the default when the driveId argument is omitted', () => {
    expect(resolveOrThrowDriveId(undefined, withCurrentDrive('viewed-drive'))).toBe('viewed-drive');
  });

  // The message must point the model at list_drives — a bare "driveId is
  // required" is what pushed it to guess (and land in Home) in the first place.
  it('throws a clear error naming list_drives when no drive can be resolved', () => {
    expect(() => resolveOrThrowDriveId(undefined, {} as ToolExecutionContext)).toThrow(
      'driveId is required: no workspace is currently in view and none was provided. Use list_drives to choose one.',
    );
  });

  it('throws when context itself is undefined and no explicit driveId is given', () => {
    expect(() => resolveOrThrowDriveId(undefined, undefined)).toThrow('driveId is required');
  });
});
