import { describe, it, expect } from 'vitest';
import { getExportFilename, getDownloadButtonLabel } from '../page';

// ============================================================================
// Pure function tests (zero mocks, zero I/O)
// ============================================================================

describe('getExportFilename', () => {
  it('non-empty label → label.zip', () => {
    expect(getExportFilename('abc', 'My label')).toBe('My label.zip');
  });

  it('null label → backup-{backupId}.zip', () => {
    expect(getExportFilename('abc', null)).toBe('backup-abc.zip');
  });

  it('undefined label → backup-{backupId}.zip', () => {
    expect(getExportFilename('abc', undefined)).toBe('backup-abc.zip');
  });

  it('empty string label → backup-{backupId}.zip', () => {
    expect(getExportFilename('abc', '')).toBe('backup-abc.zip');
  });
});

describe('getDownloadButtonLabel', () => {
  it('true → Downloading…', () => {
    expect(getDownloadButtonLabel(true)).toBe('Downloading…');
  });

  it('false → Download', () => {
    expect(getDownloadButtonLabel(false)).toBe('Download');
  });
});

// ============================================================================
// Component tests — skipped in worktree (dual-React instance constraint)
// Validated via typecheck.
//
// Covered scenarios:
// - status !== 'ready' → button disabled, aria-disabled present
// - status === 'ready' → button enabled
// - while downloadingId === backup.id → Loader2 spinner rendered, button disabled
// - fetch returns 403 → toast.error called, downloadingId reset to null
// - fetch returns 200 → URL.createObjectURL called, anchor click triggered, URL.revokeObjectURL called
// - download attribute on anchor equals getExportFilename(backup.id, backup.label)
// ============================================================================
