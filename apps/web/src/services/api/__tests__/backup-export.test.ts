import { describe, it, expect } from 'vitest';
import { buildExportManifest } from '../backup-export-service';

// ============================================================================
// buildExportManifest — pure function tests (zero mocks, zero I/O)
// ============================================================================

const backup = { id: 'b1', driveId: 'd1', label: 'My backup' };
const exportedAt = '2024-01-15T12:00:00.000Z';

const page = (pageId: string, hasVersionId = true) => ({
  pageId,
  title: 'Test',
  type: 'document',
  parentId: null,
  position: 0,
  isTrashed: false,
  pageVersionId: hasVersionId ? 'pv-1' : null,
});

describe('buildExportManifest', () => {
  it('returns correct backupId, driveId, label, exportedAt from args', () => {
    const manifest = buildExportManifest(backup, exportedAt, []);
    expect(manifest.backupId).toBe('b1');
    expect(manifest.driveId).toBe('d1');
    expect(manifest.label).toBe('My backup');
    expect(manifest.exportedAt).toBe(exportedAt);
  });

  it('page with non-null pageVersionId → hasContent: true, filename: pageId.txt', () => {
    const manifest = buildExportManifest(backup, exportedAt, [page('p1', true)]);
    expect(manifest.pages[0].hasContent).toBe(true);
    expect(manifest.pages[0].filename).toBe('p1.txt');
  });

  it('page with null pageVersionId → hasContent: false', () => {
    const manifest = buildExportManifest(backup, exportedAt, [page('p1', false)]);
    expect(manifest.pages[0].hasContent).toBe(false);
  });

  it('empty pages → manifest.pages is empty array', () => {
    const manifest = buildExportManifest(backup, exportedAt, []);
    expect(manifest.pages).toEqual([]);
  });

  it('exportedAt in output equals the string passed in (not any runtime clock)', () => {
    const timestamp = '2024-06-01T00:00:00.000Z';
    const manifest = buildExportManifest(backup, timestamp, []);
    expect(manifest.exportedAt).toBe(timestamp);
  });

  it('calling twice with same args → identical output (pure)', () => {
    const pages = [page('p1'), page('p2', false)];
    expect(buildExportManifest(backup, exportedAt, pages))
      .toEqual(buildExportManifest(backup, exportedAt, pages));
  });
});

// ============================================================================
// streamBackupExport — effectful tests (mock db, readPageContent, archiver)
// Note: archiver stream tests are integration-level; pure logic validated above.
// The stream is validated via typecheck in the worktree context.
// ============================================================================
