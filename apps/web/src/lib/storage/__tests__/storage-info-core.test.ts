import { describe, it, expect } from 'vitest';

import {
  getFileTypeCategory,
  buildFileTypeBreakdown,
  pickLargestFiles,
  pickRecentFiles,
  buildStorageByDrive,
  type UserFileRow,
} from '../storage-info-core';

function row(overrides: Partial<UserFileRow>): UserFileRow {
  return {
    fileId: 'hash-1',
    sizeBytes: 100,
    mimeType: 'application/pdf',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    driveId: 'drive-1',
    pageId: 'page-1',
    title: 'file.pdf',
    ...overrides,
  };
}

describe('storage-info-core', () => {
  describe('getFileTypeCategory', () => {
    it('getFileTypeCategory_withKnownMimeTypes_mapsToCategories', () => {
      expect(getFileTypeCategory('image/png')).toBe('Images');
      expect(getFileTypeCategory('video/mp4')).toBe('Videos');
      expect(getFileTypeCategory('audio/mpeg')).toBe('Audio');
      expect(getFileTypeCategory('text/plain')).toBe('Text');
      expect(getFileTypeCategory('application/pdf')).toBe('PDFs');
      expect(getFileTypeCategory('application/msword')).toBe('Documents');
      expect(getFileTypeCategory('application/vnd.ms-excel')).toBe('Spreadsheets');
      expect(getFileTypeCategory('application/vnd.ms-powerpoint')).toBe('Presentations');
      expect(getFileTypeCategory('application/zip')).toBe('Archives');
    });

    it('getFileTypeCategory_withUnknownOrMissingMime_returnsOther', () => {
      expect(getFileTypeCategory('application/octet-stream')).toBe('Other');
      expect(getFileTypeCategory('unknown')).toBe('Other');
      expect(getFileTypeCategory(null)).toBe('Other');
      expect(getFileTypeCategory('')).toBe('Other');
    });
  });

  describe('buildFileTypeBreakdown', () => {
    it('buildFileTypeBreakdown_withMixedFiles_groupsCountAndSizeByCategory', () => {
      const rows = [
        row({ fileId: 'a', sizeBytes: 100, mimeType: 'image/png' }),
        row({ fileId: 'b', sizeBytes: 200, mimeType: 'image/jpeg' }),
        row({ fileId: 'c', sizeBytes: 50, mimeType: 'application/pdf' }),
      ];
      expect(buildFileTypeBreakdown(rows)).toEqual({
        Images: { count: 2, totalSize: 300 },
        PDFs: { count: 1, totalSize: 50 },
      });
    });

    it('buildFileTypeBreakdown_withEmptyList_returnsEmptyObject', () => {
      expect(buildFileTypeBreakdown([])).toEqual({});
    });
  });

  describe('pickLargestFiles', () => {
    it('pickLargestFiles_sortsBySizeDescAndLimits', () => {
      const rows = [
        row({ fileId: 'a', sizeBytes: 100 }),
        row({ fileId: 'b', sizeBytes: 300 }),
        row({ fileId: 'c', sizeBytes: 200 }),
      ];
      expect(pickLargestFiles(rows, 2).map((r) => r.fileId)).toEqual(['b', 'c']);
    });

    it('pickLargestFiles_doesNotMutateInput', () => {
      const rows = [row({ fileId: 'a', sizeBytes: 1 }), row({ fileId: 'b', sizeBytes: 2 })];
      pickLargestFiles(rows, 2);
      expect(rows.map((r) => r.fileId)).toEqual(['a', 'b']);
    });
  });

  describe('pickRecentFiles', () => {
    it('pickRecentFiles_sortsByCreatedAtDescAndLimits', () => {
      const rows = [
        row({ fileId: 'a', createdAt: new Date('2026-01-01') }),
        row({ fileId: 'b', createdAt: new Date('2026-03-01') }),
        row({ fileId: 'c', createdAt: new Date('2026-02-01') }),
      ];
      expect(pickRecentFiles(rows, 2).map((r) => r.fileId)).toEqual(['b', 'c']);
    });
  });

  describe('buildStorageByDrive', () => {
    it('buildStorageByDrive_groupsFileBytesByDrive', () => {
      const rows = [
        row({ fileId: 'a', driveId: 'drive-1', sizeBytes: 100 }),
        row({ fileId: 'b', driveId: 'drive-1', sizeBytes: 200 }),
        row({ fileId: 'c', driveId: 'drive-2', sizeBytes: 50 }),
      ];
      const drives = [
        { id: 'drive-1', name: 'Main' },
        { id: 'drive-2', name: 'Second' },
        { id: 'drive-3', name: 'Empty' },
      ];
      expect(buildStorageByDrive(rows, drives)).toEqual([
        { driveId: 'drive-1', driveName: 'Main', fileCount: 2, totalSize: 300 },
        { driveId: 'drive-2', driveName: 'Second', fileCount: 1, totalSize: 50 },
        { driveId: 'drive-3', driveName: 'Empty', fileCount: 0, totalSize: 0 },
      ]);
    });

    it('buildStorageByDrive_withDrivelessFiles_ignoresThemInPerDriveTotals', () => {
      // DM attachments have no drive; they count toward overall usage but not
      // toward any drive bucket.
      const rows = [row({ fileId: 'a', driveId: null, sizeBytes: 100 })];
      expect(buildStorageByDrive(rows, [{ id: 'drive-1', name: 'Main' }])).toEqual([
        { driveId: 'drive-1', driveName: 'Main', fileCount: 0, totalSize: 0 },
      ]);
    });
  });
});
