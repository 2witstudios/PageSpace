import { describe, it, expect } from 'vitest';

import {
  buildLastMessagePreview,
  deriveConversationLastMessage,
  deriveLatestTimestamp,
} from '../message-derived-state';
import type { AttachmentMeta } from '@pagespace/db/schema/storage';

interface AssertParams {
  given: string;
  should: string;
  actual: unknown;
  expected: unknown;
}

const assert = ({ given, should, actual, expected }: AssertParams): void => {
  expect(actual, `Given ${given}, should ${should}`).toEqual(expected);
};

const imageMeta: AttachmentMeta = {
  originalName: 'photo.png',
  size: 1024,
  mimeType: 'image/png',
  contentHash: 'hash-1',
};

const pdfMeta: AttachmentMeta = {
  originalName: 'doc.pdf',
  size: 2048,
  mimeType: 'application/pdf',
  contentHash: 'hash-2',
};

describe('buildLastMessagePreview', () => {
  it('returns trimmed content when present', () => {
    assert({
      given: 'non-empty content with surrounding whitespace',
      should: 'return the trimmed content verbatim',
      actual: buildLastMessagePreview('  hello there  ', null),
      expected: 'hello there',
    });
  });

  it('truncates content longer than 100 chars with an ellipsis', () => {
    const long = 'x'.repeat(150);
    assert({
      given: 'content longer than 100 characters',
      should: 'truncate to 100 chars plus an ellipsis',
      actual: buildLastMessagePreview(long, null),
      expected: 'x'.repeat(100) + '...',
    });
  });

  it('uses the [image: name] placeholder for image attachments with empty content', () => {
    assert({
      given: 'whitespace-only content with an image attachment',
      should: 'fall back to the image placeholder',
      actual: buildLastMessagePreview('   ', imageMeta),
      expected: '[image: photo.png]',
    });
  });

  it('uses the [file: name] placeholder for non-image attachments with empty content', () => {
    assert({
      given: 'empty content with a non-image attachment',
      should: 'fall back to the file placeholder',
      actual: buildLastMessagePreview('', pdfMeta),
      expected: '[file: doc.pdf]',
    });
  });

  it('returns an empty string when there is neither content nor attachment', () => {
    assert({
      given: 'empty content and no attachment',
      should: 'return an empty string',
      actual: buildLastMessagePreview('', null),
      expected: '',
    });
  });
});

describe('deriveConversationLastMessage', () => {
  it('derives timestamp and preview from the newest surviving row', () => {
    const createdAt = new Date('2026-07-01T10:00:00Z');
    assert({
      given: 'a newest surviving active top-level message',
      should: 'derive lastMessageAt from its createdAt and the preview from its content',
      actual: deriveConversationLastMessage({ createdAt, content: 'latest words', attachmentMeta: null }),
      expected: { lastMessageAt: createdAt, lastMessagePreview: 'latest words' },
    });
  });

  it('derives the attachment placeholder when the newest row is attachment-only', () => {
    const createdAt = new Date('2026-07-01T11:00:00Z');
    assert({
      given: 'a newest surviving message with no text but an image attachment',
      should: 'derive the preview via the attachment placeholder',
      actual: deriveConversationLastMessage({ createdAt, content: '', attachmentMeta: imageMeta }),
      expected: { lastMessageAt: createdAt, lastMessagePreview: '[image: photo.png]' },
    });
  });

  it('clears both fields when no active message survives', () => {
    assert({
      given: 'no surviving active top-level message',
      should: 'null out both derived fields so no deleted content lingers',
      actual: deriveConversationLastMessage(null),
      expected: { lastMessageAt: null, lastMessagePreview: null },
    });
  });
});

describe('deriveLatestTimestamp', () => {
  it('returns the max timestamp from an unsorted list', () => {
    const a = new Date('2026-07-01T10:00:00Z');
    const b = new Date('2026-07-03T10:00:00Z');
    const c = new Date('2026-07-02T10:00:00Z');
    assert({
      given: 'several surviving timestamps in arbitrary order',
      should: 'return the latest one',
      actual: deriveLatestTimestamp([a, b, c]),
      expected: b,
    });
  });

  it('returns null for an empty list', () => {
    assert({
      given: 'no surviving rows',
      should: 'return null so the derived column is cleared, not left stale',
      actual: deriveLatestTimestamp([]),
      expected: null,
    });
  });
});

describe('buildLastMessagePreview with several attachments', () => {
  it('counts a batch of images rather than naming one of them', () => {
    assert({
      given: 'an attachment-only message carrying three images',
      should: 'describe the batch — naming one file reads as though the others went missing',
      actual: buildLastMessagePreview('', [imageMeta, imageMeta, imageMeta]),
      expected: '[3 images]',
    });
  });

  it('counts a batch of non-images as files', () => {
    assert({
      given: 'an attachment-only message carrying two PDFs',
      should: 'describe them as files',
      actual: buildLastMessagePreview('', [pdfMeta, pdfMeta]),
      expected: '[2 files]',
    });
  });

  it('falls back to the neutral noun for a mixed batch', () => {
    assert({
      given: 'a batch of one image and one PDF',
      should: 'avoid claiming the batch is all images or all files',
      actual: buildLastMessagePreview('', [imageMeta, pdfMeta]),
      expected: '[2 attachments]',
    });
  });

  it('names the file when a batch holds exactly one', () => {
    assert({
      given: 'a single-element array',
      should: 'read identically to the legacy singular form — one file is still worth naming',
      actual: buildLastMessagePreview('', [imageMeta]),
      expected: buildLastMessagePreview('', imageMeta),
    });
  });

  it('still prefers the message text over any attachment count', () => {
    assert({
      given: 'a message with both text and three images',
      should: 'preview the text — the attachment placeholder is only a fallback',
      actual: buildLastMessagePreview('look at these', [imageMeta, imageMeta, imageMeta]),
      expected: 'look at these',
    });
  });

  it('treats an empty array as no attachment at all', () => {
    assert({
      given: 'an empty attachment array and no text',
      should: 'return the empty preview rather than "[0 files]"',
      actual: buildLastMessagePreview('', []),
      expected: '',
    });
  });
});
