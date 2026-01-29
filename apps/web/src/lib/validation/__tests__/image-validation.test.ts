import { describe, it, expect } from 'vitest';
import {
  ALLOWED_IMAGE_TYPES,
  isAllowedImageType,
  extractBase64DataUrl,
  validateMagicBytes,
  validateImageAttachment,
} from '../image-validation';

/**
 * Image Validation Utilities - Zero Trust Validation
 *
 * These utilities enforce zero-trust validation for image attachments:
 * 1. MIME type must be in allowlist
 * 2. Data URL format must match declared type
 * 3. Magic bytes must match declared MIME type (prevents spoofing)
 */

describe('image-validation', () => {
  describe('ALLOWED_IMAGE_TYPES', () => {
    it('includes standard web image formats', () => {
      expect(ALLOWED_IMAGE_TYPES).toContain('image/jpeg');
      expect(ALLOWED_IMAGE_TYPES).toContain('image/png');
      expect(ALLOWED_IMAGE_TYPES).toContain('image/gif');
      expect(ALLOWED_IMAGE_TYPES).toContain('image/webp');
    });

    it('does not include potentially dangerous formats', () => {
      expect(ALLOWED_IMAGE_TYPES).not.toContain('image/svg+xml');
      expect(ALLOWED_IMAGE_TYPES).not.toContain('application/pdf');
      expect(ALLOWED_IMAGE_TYPES).not.toContain('text/html');
    });
  });

  describe('isAllowedImageType', () => {
    it('given a valid image MIME type, should return true', () => {
      expect(isAllowedImageType('image/jpeg')).toBe(true);
      expect(isAllowedImageType('image/png')).toBe(true);
      expect(isAllowedImageType('image/gif')).toBe(true);
      expect(isAllowedImageType('image/webp')).toBe(true);
    });

    it('given an invalid MIME type, should return false', () => {
      expect(isAllowedImageType('image/svg+xml')).toBe(false);
      expect(isAllowedImageType('application/javascript')).toBe(false);
      expect(isAllowedImageType('text/html')).toBe(false);
      expect(isAllowedImageType('')).toBe(false);
    });

    it('given a case variation, should return false (strict matching)', () => {
      expect(isAllowedImageType('IMAGE/JPEG')).toBe(false);
      expect(isAllowedImageType('Image/Png')).toBe(false);
    });
  });

  describe('extractBase64DataUrl', () => {
    it('given a valid data URL, should extract MIME type and base64 content', () => {
      const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const result = extractBase64DataUrl(dataUrl);

      expect(result).not.toBeNull();
      expect(result?.mimeType).toBe('image/png');
      expect(result?.base64Data).toBe('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
    });

    it('given an invalid data URL format, should return null', () => {
      expect(extractBase64DataUrl('not-a-data-url')).toBeNull();
      expect(extractBase64DataUrl('data:image/png')).toBeNull(); // missing base64
      expect(extractBase64DataUrl('data:;base64,abc')).toBeNull(); // missing MIME
      expect(extractBase64DataUrl('')).toBeNull();
    });

    it('given a data URL with unusual but valid MIME, should extract correctly', () => {
      const dataUrl = 'data:application/octet-stream;base64,AAAA';
      const result = extractBase64DataUrl(dataUrl);

      expect(result?.mimeType).toBe('application/octet-stream');
      expect(result?.base64Data).toBe('AAAA');
    });
  });

  describe('validateMagicBytes', () => {
    // Real magic bytes for each format (minimal valid examples)
    const VALID_PNG_BASE64 = 'iVBORw0KGgo='; // PNG magic: 89 50 4E 47 0D 0A 1A 0A
    const VALID_JPEG_BASE64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof'; // JPEG magic: FF D8 FF
    const VALID_GIF_BASE64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'; // GIF magic: 47 49 46 (GIF89a)
    const VALID_WEBP_BASE64 = 'UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA='; // RIFF....WEBP

    it('given valid PNG bytes with image/png type, should return true', () => {
      expect(validateMagicBytes(VALID_PNG_BASE64, 'image/png')).toBe(true);
    });

    it('given valid JPEG bytes with image/jpeg type, should return true', () => {
      expect(validateMagicBytes(VALID_JPEG_BASE64, 'image/jpeg')).toBe(true);
    });

    it('given valid GIF bytes with image/gif type, should return true', () => {
      expect(validateMagicBytes(VALID_GIF_BASE64, 'image/gif')).toBe(true);
    });

    it('given valid WebP bytes with image/webp type, should return true', () => {
      expect(validateMagicBytes(VALID_WEBP_BASE64, 'image/webp')).toBe(true);
    });

    it('given PNG bytes but declared as JPEG (spoofing attempt), should return false', () => {
      expect(validateMagicBytes(VALID_PNG_BASE64, 'image/jpeg')).toBe(false);
    });

    it('given JPEG bytes but declared as PNG (spoofing attempt), should return false', () => {
      expect(validateMagicBytes(VALID_JPEG_BASE64, 'image/png')).toBe(false);
    });

    it('given random bytes that do not match any magic signature, should return false', () => {
      const randomBase64 = 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo='; // "abcdefghijklmnopqrstuvwxyz"
      expect(validateMagicBytes(randomBase64, 'image/png')).toBe(false);
      expect(validateMagicBytes(randomBase64, 'image/jpeg')).toBe(false);
    });

    it('given empty or invalid base64, should return false', () => {
      expect(validateMagicBytes('', 'image/png')).toBe(false);
      expect(validateMagicBytes('!!!invalid!!!', 'image/png')).toBe(false);
    });

    it('given an unsupported MIME type, should return false', () => {
      expect(validateMagicBytes(VALID_PNG_BASE64, 'image/svg+xml' as any)).toBe(false);
    });
  });

  describe('validateImageAttachment', () => {
    const VALID_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';
    const VALID_JPEG_DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof';

    it('given valid attachment with matching type and magic bytes, should return success', () => {
      const result = validateImageAttachment({
        name: 'test.png',
        type: 'image/png',
        data: VALID_PNG_DATA_URL,
      });

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('given disallowed MIME type, should return error', () => {
      const result = validateImageAttachment({
        name: 'script.svg',
        type: 'image/svg+xml',
        data: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('not allowed');
    });

    it('given mismatched declared type and data URL type, should return error', () => {
      const result = validateImageAttachment({
        name: 'test.png',
        type: 'image/png',
        data: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/',
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('mismatch');
    });

    it('given valid format but spoofed magic bytes, should return error', () => {
      // PNG header in data URL but random content that is not PNG
      const spoofedDataUrl = 'data:image/png;base64,YWJjZGVmZ2hpamtsbW5vcA==';
      const result = validateImageAttachment({
        name: 'fake.png',
        type: 'image/png',
        data: spoofedDataUrl,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('magic bytes');
    });

    it('given invalid data URL format, should return error', () => {
      const result = validateImageAttachment({
        name: 'test.png',
        type: 'image/png',
        data: 'not-a-valid-data-url',
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid data URL');
    });
  });
});
