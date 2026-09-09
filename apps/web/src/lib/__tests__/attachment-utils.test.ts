/**
 * `getAttachments` is the single seam between messages written since they
 * gained real attachment rows and messages written before that, which carry
 * only the legacy `fileId` / `attachmentMeta` / `file` fields. Both shapes have
 * to render on one path, so this is where that promise is pinned.
 */
import { describe, it, expect } from 'vitest';
import { getAttachments, isImageAttachment, type MessageWithAttachment } from '../attachment-utils';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

const meta = (name: string, mimeType = 'image/png') => ({
  originalName: name,
  size: 1,
  mimeType,
  contentHash: 'a'.repeat(64),
});

describe('getAttachments', () => {
  it('reads every attachment row on a modern message', () => {
    const message: MessageWithAttachment = {
      fileId: 'f-1',
      attachmentMeta: meta('one.png'),
      attachments: [
        { id: 'a-1', fileId: 'f-1', attachmentMeta: meta('one.png') },
        { id: 'a-2', fileId: 'f-2', attachmentMeta: meta('two.png') },
        { id: 'a-3', fileId: 'f-3', attachmentMeta: meta('three.png') },
      ],
    };
    assert({
      given: 'a message with three attachment rows and legacy columns mirroring the first',
      should: 'return all three, not the legacy single',
      actual: getAttachments(message).map((a) => a.fileId),
      expected: ['f-1', 'f-2', 'f-3'],
    });
  });

  it('orders by position, not by the order the rows arrived', () => {
    // The repositories' shared `with` clause cannot carry an orderBy, so the
    // database is free to hand these back in any order. Position is the order
    // the sender chose, and it is the only thing that may decide the layout.
    const message: MessageWithAttachment = {
      attachments: [
        { id: 'a-3', fileId: 'f-3', attachmentMeta: meta('third.png'), position: 2 },
        { id: 'a-1', fileId: 'f-1', attachmentMeta: meta('first.png'), position: 0 },
        { id: 'a-2', fileId: 'f-2', attachmentMeta: meta('second.png'), position: 1 },
      ],
    };
    assert({
      given: 'attachment rows returned out of order',
      should: 'render them in the order the sender attached them',
      actual: getAttachments(message).map((a) => a.fileId),
      expected: ['f-1', 'f-2', 'f-3'],
    });
  });

  it('falls back to the legacy columns on a pre-migration message', () => {
    const message: MessageWithAttachment = { fileId: 'f-9', attachmentMeta: meta('old.png') };
    assert({
      given: 'a message written before attachment rows existed',
      should: 'synthesize a one-element list so it renders on the same path',
      actual: getAttachments(message).map((a) => a.fileId),
      expected: ['f-9'],
    });
  });

  it('falls back when the attachments array is present but empty', () => {
    // A text-only message read through the new relation has `attachments: []`.
    // Treating empty as "use the array" rather than "fall back" is what keeps a
    // text-only message from resurrecting a stale legacy column.
    const message: MessageWithAttachment = {
      fileId: null,
      attachmentMeta: null,
      attachments: [],
    };
    assert({
      given: 'a text-only message',
      should: 'return nothing to render',
      actual: getAttachments(message),
      expected: [],
    });
  });

  it('drops an attachment whose file was hard-deleted, keeping its siblings', () => {
    const message: MessageWithAttachment = {
      attachments: [
        { id: 'a-1', fileId: 'f-1', attachmentMeta: meta('kept.png') },
        // ON DELETE SET NULL leaves the row and its meta, minus the file.
        { id: 'a-2', fileId: null, attachmentMeta: meta('gone.png') },
        { id: 'a-3', fileId: 'f-3', attachmentMeta: meta('also-kept.png') },
      ],
    };
    assert({
      given: 'a gallery where one file was hard-deleted',
      should: 'drop just that tile — the rest of the batch still renders',
      actual: getAttachments(message).map((a) => a.fileId),
      expected: ['f-1', 'f-3'],
    });
  });

  it('keeps the same file twice, since file ids are content hashes', () => {
    const message: MessageWithAttachment = {
      attachments: [
        { id: 'a-1', fileId: 'f-1', attachmentMeta: meta('same.png') },
        { id: 'a-2', fileId: 'f-1', attachmentMeta: meta('same.png') },
      ],
    };
    assert({
      given: 'the same photo attached twice',
      should: 'render both tiles — the ids match because storage is content-addressed',
      actual: getAttachments(message).length,
      expected: 2,
    });
  });

  it('reads a bare attachment row as an attachment', () => {
    // The row shape is a structural superset of the legacy message shape, which
    // is what lets one set of accessors serve both.
    assert({
      given: 'a single attachment row passed on its own',
      should: 'be readable by the same predicates a message is',
      actual: isImageAttachment({ fileId: 'f-1', attachmentMeta: meta('x.png') }),
      expected: true,
    });
  });
});

describe('getAttachments as a render predicate', () => {
  it.each([
    ['a modern message with rows', { attachments: [{ fileId: 'f-1', attachmentMeta: meta('a.png') }] }, 1],
    ['a legacy message', { fileId: 'f-1', attachmentMeta: meta('a.png') }, 1],
    ['a text-only message', { fileId: null, attachmentMeta: null }, 0],
    ['a message whose only file was deleted', { attachments: [{ fileId: null, attachmentMeta: meta('x.png') }] }, 0],
  ])('reports the right tile count for %s', (_label, message, expected) => {
    expect(getAttachments(message as MessageWithAttachment).length).toBe(expected);
  });
});
