import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { validateUserMessageFileParts, hasFileParts } from '../validate-image-parts';

// Real valid base64 image data for testing
const VALID_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';
const VALID_JPEG_DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof';

function makeUserMessage(parts: unknown[]): UIMessage {
  return {
    id: 'test-msg',
    role: 'user',
    parts,
    createdAt: new Date(),
  } as UIMessage;
}

function makeFilePart(overrides: Partial<{ url: string; mediaType: string; filename: string }> = {}) {
  return {
    type: 'file' as const,
    url: overrides.url ?? VALID_PNG_DATA_URL,
    mediaType: overrides.mediaType ?? 'image/png',
    filename: overrides.filename ?? 'test.png',
  };
}

describe('validate-image-parts', () => {
  describe('hasFileParts', () => {
    it('given a message with no file parts, should return false', () => {
      const msg = makeUserMessage([{ type: 'text', text: 'Hello' }]);
      expect(hasFileParts(msg)).toBe(false);
    });

    it('given a message with a file part, should return true', () => {
      const msg = makeUserMessage([
        { type: 'text', text: 'Hello' },
        makeFilePart(),
      ]);
      expect(hasFileParts(msg)).toBe(true);
    });

    it('given a message with undefined parts, should return false', () => {
      const msg = { id: 'test', role: 'user' as const, parts: undefined } as unknown as UIMessage;
      expect(hasFileParts(msg)).toBe(false);
    });
  });

  describe('validateUserMessageFileParts', () => {
    it('given a message with no file parts, should return valid with count 0', () => {
      const msg = makeUserMessage([{ type: 'text', text: 'Hi' }]);
      const result = validateUserMessageFileParts(msg);
      expect(result.valid).toBe(true);
      expect(result.filePartCount).toBe(0);
    });

    it('given a valid PNG image, should return valid', () => {
      const msg = makeUserMessage([makeFilePart()]);
      const result = validateUserMessageFileParts(msg);
      expect(result.valid).toBe(true);
      expect(result.filePartCount).toBe(1);
    });

    it('given a valid JPEG image, should return valid', () => {
      const msg = makeUserMessage([
        makeFilePart({
          url: VALID_JPEG_DATA_URL,
          mediaType: 'image/jpeg',
          filename: 'photo.jpg',
        }),
      ]);
      const result = validateUserMessageFileParts(msg);
      expect(result.valid).toBe(true);
      expect(result.filePartCount).toBe(1);
    });

    it('given more than 5 file parts, should return invalid with count error', () => {
      const parts = Array.from({ length: 6 }, (_, i) =>
        makeFilePart({ filename: `img-${i}.png` })
      );
      const msg = makeUserMessage(parts);
      const result = validateUserMessageFileParts(msg);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Too many');
      expect(result.filePartCount).toBe(6);
    });

    it('given exactly 5 file parts, should return valid', () => {
      const parts = Array.from({ length: 5 }, (_, i) =>
        makeFilePart({ filename: `img-${i}.png` })
      );
      const msg = makeUserMessage(parts);
      const result = validateUserMessageFileParts(msg);
      expect(result.valid).toBe(true);
      expect(result.filePartCount).toBe(5);
    });

    it('given a disallowed MIME type, should return invalid', () => {
      const msg = makeUserMessage([
        makeFilePart({
          url: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
          mediaType: 'image/svg+xml',
          filename: 'vector.svg',
        }),
      ]);
      const result = validateUserMessageFileParts(msg);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not allowed');
    });

    it('given a non-data-URL, should return invalid', () => {
      const msg = makeUserMessage([
        makeFilePart({ url: 'https://example.com/img.png' }),
      ]);
      const result = validateUserMessageFileParts(msg);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not a valid data URL');
    });

    it('given an invalid data URL format, should return invalid', () => {
      const msg = makeUserMessage([
        makeFilePart({ url: 'data:broken' }),
      ]);
      const result = validateUserMessageFileParts(msg);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid data URL');
    });

    it('given spoofed magic bytes, should return invalid', () => {
      // Declares image/png but the base64 content is plain text, not PNG
      const msg = makeUserMessage([
        makeFilePart({
          url: 'data:image/png;base64,YWJjZGVmZ2hpamtsbW5vcA==',
          mediaType: 'image/png',
        }),
      ]);
      const result = validateUserMessageFileParts(msg);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('magic bytes');
    });

    it('given a data URL exceeding 4MB, should return invalid', () => {
      // Create a data URL > 4MB
      const largeBase64 = 'A'.repeat(4 * 1024 * 1024 + 100);
      const msg = makeUserMessage([
        makeFilePart({ url: `data:image/png;base64,${largeBase64}` }),
      ]);
      const result = validateUserMessageFileParts(msg);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('4MB');
    });

    it('given mixed text and valid file parts, should validate the file parts only', () => {
      const msg = makeUserMessage([
        { type: 'text', text: 'Look at this:' },
        makeFilePart(),
        { type: 'text', text: 'What do you see?' },
      ]);
      const result = validateUserMessageFileParts(msg);
      expect(result.valid).toBe(true);
      expect(result.filePartCount).toBe(1);
    });
  });
});
