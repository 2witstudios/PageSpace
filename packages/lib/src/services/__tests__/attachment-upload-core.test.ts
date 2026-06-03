import { describe, it, expect } from 'vitest';
import {
  validateAttachmentPresign,
  attachmentFileDriveId,
  buildAttachmentFileRecord,
  buildAttachmentResult,
  slotTargetMatches,
  type AttachmentTarget,
} from '../attachment-upload-core';

const HASH = 'a'.repeat(64);
const PAGE_TARGET: AttachmentTarget = { type: 'page', pageId: 'page-1', driveId: 'drive-1' };
const CONV_TARGET: AttachmentTarget = { type: 'conversation', conversationId: 'conv-1' };

describe('validateAttachmentPresign', () => {
  it('returns the canonicalized lowercase hash for valid input', () => {
    const result = validateAttachmentPresign({
      contentHash: 'A'.repeat(64),
      mimeType: 'image/png',
      fileSize: 1024,
      tier: 'free',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.canonicalHash).toBe('a'.repeat(64));
  });

  it('rejects a malformed content hash with status 400', () => {
    const result = validateAttachmentPresign({
      contentHash: 'not-a-hash',
      mimeType: 'image/png',
      fileSize: 1024,
      tier: 'free',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it('rejects a blocked MIME type with status 400', () => {
    const result = validateAttachmentPresign({
      contentHash: HASH,
      mimeType: 'text/html',
      fileSize: 1024,
      tier: 'free',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it('rejects a file exceeding the tier size limit with status 413', () => {
    const result = validateAttachmentPresign({
      contentHash: HASH,
      mimeType: 'image/png',
      fileSize: 100 * 1024 * 1024, // 100MB > free tier 50MB
      tier: 'free',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(413);
  });
});

describe('attachmentFileDriveId', () => {
  it('returns the drive id for a page target', () => {
    expect(attachmentFileDriveId(PAGE_TARGET)).toBe('drive-1');
  });

  it('returns null for a conversation target (DM files have no drive)', () => {
    expect(attachmentFileDriveId(CONV_TARGET)).toBeNull();
  });
});

describe('buildAttachmentFileRecord', () => {
  it('builds a content-addressed file row for a page target with its drive id', () => {
    const record = buildAttachmentFileRecord({
      contentHash: HASH,
      target: PAGE_TARGET,
      fileSize: 2048,
      mimeType: 'image/png',
      userId: 'user-1',
    });
    expect(record).toEqual({
      id: HASH,
      driveId: 'drive-1',
      sizeBytes: 2048,
      mimeType: 'image/png',
      storagePath: HASH,
      createdBy: 'user-1',
    });
  });

  it('builds a file row with null drive id for a conversation target', () => {
    const record = buildAttachmentFileRecord({
      contentHash: HASH,
      target: CONV_TARGET,
      fileSize: 2048,
      mimeType: 'application/pdf',
      userId: 'user-1',
    });
    expect(record.driveId).toBeNull();
    expect(record.id).toBe(HASH);
    expect(record.storagePath).toBe(HASH);
  });
});

describe('buildAttachmentResult', () => {
  it('maps stored file fields to the client FileAttachment shape', () => {
    const result = buildAttachmentResult({
      contentHash: HASH,
      originalName: 'photo.png',
      sanitizedName: 'photo.png',
      size: 4096,
      mimeType: 'image/png',
    });
    expect(result).toEqual({
      id: HASH,
      originalName: 'photo.png',
      sanitizedName: 'photo.png',
      size: 4096,
      mimeType: 'image/png',
      contentHash: HASH,
    });
  });
});

describe('slotTargetMatches', () => {
  it('matches identical page targets', () => {
    expect(slotTargetMatches(PAGE_TARGET, { type: 'page', pageId: 'page-1', driveId: 'drive-1' })).toBe(true);
  });

  it('rejects page targets with a different page id', () => {
    expect(slotTargetMatches(PAGE_TARGET, { type: 'page', pageId: 'page-2', driveId: 'drive-1' })).toBe(false);
  });

  it('rejects page targets with a different drive id', () => {
    expect(slotTargetMatches(PAGE_TARGET, { type: 'page', pageId: 'page-1', driveId: 'drive-2' })).toBe(false);
  });

  it('matches identical conversation targets', () => {
    expect(slotTargetMatches(CONV_TARGET, { type: 'conversation', conversationId: 'conv-1' })).toBe(true);
  });

  it('rejects conversation targets with a different conversation id', () => {
    expect(slotTargetMatches(CONV_TARGET, { type: 'conversation', conversationId: 'conv-2' })).toBe(false);
  });

  it('rejects a page target against a conversation target', () => {
    expect(slotTargetMatches(PAGE_TARGET, CONV_TARGET)).toBe(false);
  });
});
