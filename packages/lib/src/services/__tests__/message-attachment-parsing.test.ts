/**
 * The send routes' attachment door: shape validation, the legacy-body bridge,
 * and the cap.
 *
 * Both routes share this because they used to disagree — the DM route
 * validated `attachmentMeta`'s shape and the channel route accepted any JSON
 * at all.
 */
import { describe, it, expect } from 'vitest';
import { MAX_MESSAGE_ATTACHMENTS, parseMessageAttachments } from '../attachment-upload-core';

interface AssertParams {
  given: string;
  should: string;
  actual: unknown;
  expected: unknown;
}

const assert = ({ given, should, actual, expected }: AssertParams): void => {
  expect(actual, `Given ${given}, should ${should}`).toEqual(expected);
};

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
      given: 'the position CHECK in 0291 (position >= 0 AND position < 10)',
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
