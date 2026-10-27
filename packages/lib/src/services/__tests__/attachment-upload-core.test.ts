import { describe, it, expect } from 'vitest';
import {
  validateAttachmentPresign,
  attachmentFileDriveId,
  buildAttachmentFileRecord,
  buildAttachmentResult,
  slotTargetMatches,
  MAX_MESSAGE_ATTACHMENTS,
  parseMessageAttachments,
  type AttachmentTarget,
} from '../attachment-upload-core';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

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

// ---------------------------------------------------------------------------
// The send routes' attachment door: shape validation, the legacy-body bridge,
// and the cap. Both routes share this because they used to disagree — the DM
// route validated attachmentMeta's shape and the channel route accepted any
// JSON at all.
// ---------------------------------------------------------------------------

const meta = {
  originalName: 'photo.png',
  size: 1024,
  mimeType: 'image/png',
  contentHash: 'hash-1',
};

describe('parseMessageAttachments', () => {
  it('reads the attachments array in order', () => {
    const result = parseMessageAttachments({
      attachments: [
        { fileId: 'f-1', attachmentMeta: meta },
        { fileId: 'f-2', attachmentMeta: meta },
      ],
    });
    assert({
      given: 'a two-element attachments array',
      should: 'preserve both entries in the order sent — that order is the display order',
      actual: result.kind === 'ok' ? result.attachments.map((a) => a.fileId) : result,
      expected: ['f-1', 'f-2'],
    });
  });

  it('accepts the legacy singular body', () => {
    const result = parseMessageAttachments({ fileId: 'f-1', attachmentMeta: meta });
    assert({
      given: 'a body from the published SDK or CLI, which sends fileId + attachmentMeta',
      should: 'normalize to a one-element array so old clients keep working',
      actual: result,
      expected: { kind: 'ok', attachments: [{ fileId: 'f-1', attachmentMeta: meta }] },
    });
  });

  it('reads a message with no attachments as an empty list', () => {
    assert({
      given: 'a text-only send',
      should: 'return no attachments rather than an error',
      actual: parseMessageAttachments({}),
      expected: { kind: 'ok', attachments: [] },
    });
  });

  it('refuses a body that sends both shapes', () => {
    const result = parseMessageAttachments({
      fileId: 'f-1',
      attachmentMeta: meta,
      attachments: [{ fileId: 'f-2', attachmentMeta: meta }],
    });
    assert({
      given: 'a body carrying both the array and the legacy pair',
      should: 'reject rather than silently pick one — guessing would drop a file the user attached',
      actual: result.kind,
      expected: 'invalid',
    });
  });

  it('refuses an attachment with no metadata', () => {
    assert({
      given: 'an attachment entry with a fileId but no attachmentMeta',
      should: 'reject — the channel route previously accepted any JSON here',
      actual: parseMessageAttachments({ attachments: [{ fileId: 'f-1' }] }).kind,
      expected: 'invalid',
    });
  });

  it('refuses an attachment whose metadata is the wrong shape', () => {
    assert({
      given: 'an attachmentMeta whose size is a string',
      should: 'reject on the field types, not just on presence',
      actual: parseMessageAttachments({
        attachments: [{ fileId: 'f-1', attachmentMeta: { ...meta, size: '1024' } }],
      }).kind,
      expected: 'invalid',
    });
  });

  it('refuses the legacy body when its metadata is missing', () => {
    assert({
      given: 'a legacy body with a fileId and no attachmentMeta',
      should: 'reject, matching the DM route behaviour this replaced',
      actual: parseMessageAttachments({ fileId: 'f-1' }).kind,
      expected: 'invalid',
    });
  });

  it('refuses more attachments than a message may carry', () => {
    const tooMany = Array.from({ length: MAX_MESSAGE_ATTACHMENTS + 1 }, (_, i) => ({
      fileId: `f-${i}`,
      attachmentMeta: meta,
    }));
    assert({
      given: 'one more attachment than the cap allows',
      should: 'reject at the door, before anything is written',
      actual: parseMessageAttachments({ attachments: tooMany }).kind,
      expected: 'invalid',
    });
  });

  it('accepts exactly the cap', () => {
    const atCap = Array.from({ length: MAX_MESSAGE_ATTACHMENTS }, (_, i) => ({
      fileId: `f-${i}`,
      attachmentMeta: meta,
    }));
    assert({
      given: 'exactly MAX_MESSAGE_ATTACHMENTS attachments',
      should: 'accept — the cap is inclusive, and the DB CHECK is written to match',
      actual: parseMessageAttachments({ attachments: atCap }).kind,
      expected: 'ok',
    });
  });

  it('refuses a non-array attachments field', () => {
    assert({
      given: 'attachments sent as a string',
      should: 'reject rather than iterate a string',
      actual: parseMessageAttachments({ attachments: 'nope' }).kind,
      expected: 'invalid',
    });
  });

  it('keeps the same file twice, since file ids are content hashes', () => {
    const result = parseMessageAttachments({
      attachments: [
        { fileId: 'f-1', attachmentMeta: meta },
        { fileId: 'f-1', attachmentMeta: meta },
      ],
    });
    assert({
      given: 'the same photo attached twice, which yields one content-addressed id',
      should: 'keep both — deduping here would silently drop a file the user chose',
      actual: result.kind === 'ok' ? result.attachments.length : result,
      expected: 2,
    });
  });
});

describe('MAX_MESSAGE_ATTACHMENTS', () => {
  it('matches the literal compiled into the database CHECK', () => {
    // The migration cannot import this constant, so the two are pinned to each
    // other from both sides. Raising the cap means a new migration, not just
    // editing this number. See message-attachments-migration.test.ts.
    assert({
      given: 'the position CHECK in 0292 (position >= 0 AND position < 10)',
      should: 'agree with the application-level cap',
      actual: MAX_MESSAGE_ATTACHMENTS,
      expected: 10,
    });
  });
});

describe('attachmentMeta shape validation', () => {
  it.each([
    ['null', null],
    ['a string', 'photo.png'],
    ['a missing contentHash', { originalName: 'a', size: 1, mimeType: 'image/png' }],
    ['a numeric originalName', { originalName: 1, size: 1, mimeType: 'image/png', contentHash: 'h' }],
  ])('rejects an attachment whose meta is %s', (_label, value) => {
    expect(
      parseMessageAttachments({ attachments: [{ fileId: 'f-1', attachmentMeta: value }] }).kind,
    ).toBe('invalid');
  });
});
