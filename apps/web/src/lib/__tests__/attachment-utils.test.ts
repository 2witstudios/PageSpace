import { describe, it, expect } from 'vitest';
import {
  isImageAttachment,
  getFileId,
  getAttachmentName,
  getAttachmentMimeType,
  getAttachmentSize,
  formatFileSize,
  hasAttachment,
} from '../attachment-utils';

describe('attachment-utils', () => {
  describe('isImageAttachment', () => {
    it('should return true when attachmentMeta mimeType starts with image/', () => {
      expect(isImageAttachment({ attachmentMeta: { originalName: 'test.png', size: 100, mimeType: 'image/png', contentHash: 'abc' } })).toBe(true);
    });

    it('should return true when file mimeType starts with image/', () => {
      expect(isImageAttachment({ file: { id: '1', mimeType: 'image/jpeg', sizeBytes: 200 } })).toBe(true);
    });

    it('should return false when no image mime type', () => {
      expect(isImageAttachment({ attachmentMeta: { originalName: 'test.pdf', size: 100, mimeType: 'application/pdf', contentHash: 'abc' } })).toBe(false);
    });

    it('should return false when no attachment data', () => {
      expect(isImageAttachment({})).toBe(false);
    });

    it('should return false when mimeType is null', () => {
      expect(isImageAttachment({ file: { id: '1', mimeType: null, sizeBytes: 0 } })).toBe(false);
    });
  });

  describe('getFileId', () => {
    it('should return fileId when present', () => {
      expect(getFileId({ fileId: 'file-1' })).toBe('file-1');
    });

    it('should return file.id when fileId is not present', () => {
      expect(getFileId({ file: { id: 'file-2', mimeType: null, sizeBytes: 0 } })).toBe('file-2');
    });

    it('should return null when neither is present', () => {
      expect(getFileId({})).toBeNull();
    });

    it('should prefer fileId over file.id', () => {
      expect(getFileId({ fileId: 'file-1', file: { id: 'file-2', mimeType: null, sizeBytes: 0 } })).toBe('file-1');
    });
  });

  describe('getAttachmentName', () => {
    it('should return originalName from attachmentMeta', () => {
      expect(getAttachmentName({ attachmentMeta: { originalName: 'photo.jpg', size: 100, mimeType: 'image/jpeg', contentHash: 'abc' } })).toBe('photo.jpg');
    });

    it('should return Attachment when no meta', () => {
      expect(getAttachmentName({})).toBe('Attachment');
    });
  });

  describe('getAttachmentMimeType', () => {
    it('should return mimeType from attachmentMeta', () => {
      expect(getAttachmentMimeType({ attachmentMeta: { originalName: 'test', size: 0, mimeType: 'image/png', contentHash: 'x' } })).toBe('image/png');
    });

    it('should fall back to file mimeType', () => {
      expect(getAttachmentMimeType({ file: { id: '1', mimeType: 'application/pdf', sizeBytes: 0 } })).toBe('application/pdf');
    });

    it('should return empty string when no mime type', () => {
      expect(getAttachmentMimeType({})).toBe('');
    });
  });

  describe('getAttachmentSize', () => {
    it('should return size from attachmentMeta', () => {
      expect(getAttachmentSize({ attachmentMeta: { originalName: 'x', size: 1024, mimeType: 'x', contentHash: 'x' } })).toBe(1024);
    });

    it('should fall back to file sizeBytes', () => {
      expect(getAttachmentSize({ file: { id: '1', mimeType: null, sizeBytes: 2048 } })).toBe(2048);
    });

    it('should return null when no size', () => {
      expect(getAttachmentSize({})).toBeNull();
    });

    it('should return 0 when size is 0', () => {
      expect(getAttachmentSize({ attachmentMeta: { originalName: 'x', size: 0, mimeType: 'x', contentHash: 'x' } })).toBe(0);
    });
  });

  describe('formatFileSize', () => {
    it('should format bytes', () => {
      expect(formatFileSize(500)).toBe('500 B');
    });

    it('should format kilobytes', () => {
      expect(formatFileSize(1536)).toBe('1.5 KB');
    });

    it('should format megabytes', () => {
      expect(formatFileSize(2 * 1024 * 1024)).toBe('2.0 MB');
    });

    it('should format zero bytes', () => {
      expect(formatFileSize(0)).toBe('0 B');
    });
  });

  describe('hasAttachment', () => {
    it('should return true when attachmentMeta and fileId exist', () => {
      expect(hasAttachment({ attachmentMeta: { originalName: 'x', size: 0, mimeType: 'x', contentHash: 'x' }, fileId: 'f1' })).toBe(true);
    });

    it('should return true when file exists with id', () => {
      expect(hasAttachment({ file: { id: '1', mimeType: null, sizeBytes: 0 } })).toBe(true);
    });

    it('should return false when no attachment data', () => {
      expect(hasAttachment({})).toBe(false);
    });

    it('should return false when attachmentMeta exists but no fileId', () => {
      expect(hasAttachment({ attachmentMeta: { originalName: 'x', size: 0, mimeType: 'x', contentHash: 'x' } })).toBe(false);
    });
  });
});
