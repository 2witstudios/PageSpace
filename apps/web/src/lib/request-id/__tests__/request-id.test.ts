import { describe, it, expect } from 'vitest';
import {
  getOrCreateRequestId,
  isValidRequestId,
  REQUEST_ID_HEADER,
} from '../request-id';

describe('request-id', () => {
  describe('REQUEST_ID_HEADER', () => {
    it('should use standard X-Request-Id header name', () => {
      expect(REQUEST_ID_HEADER).toBe('X-Request-Id');
    });
  });

  describe('isValidRequestId', () => {
    it('given a valid CUID2, should return true', () => {
      const validId = 'ckg1234567890abcdefghij';
      expect(isValidRequestId(validId)).toBe(true);
    });

    it('given a valid UUID, should return true', () => {
      const validUuid = '550e8400-e29b-41d4-a716-446655440000';
      expect(isValidRequestId(validUuid)).toBe(true);
    });

    it('given an alphanumeric ID with hyphens, should return true', () => {
      const validId = 'req-abc123-xyz789';
      expect(isValidRequestId(validId)).toBe(true);
    });

    it('given empty string, should return false', () => {
      expect(isValidRequestId('')).toBe(false);
    });

    it('given null, should return false', () => {
      expect(isValidRequestId(null)).toBe(false);
    });

    it('given undefined, should return false', () => {
      expect(isValidRequestId(undefined)).toBe(false);
    });

    it('given ID with special characters, should return false', () => {
      expect(isValidRequestId('req<script>alert(1)</script>')).toBe(false);
    });

    it('given ID over 128 characters, should return false', () => {
      const longId = 'a'.repeat(129);
      expect(isValidRequestId(longId)).toBe(false);
    });

    it('given ID with spaces, should return false', () => {
      expect(isValidRequestId('req 123')).toBe(false);
    });
  });

  describe('getOrCreateRequestId', () => {
    it('given request with valid X-Request-Id header, should return that ID', () => {
      const existingId = 'incoming-request-id-123';
      const headers = new Headers();
      headers.set('X-Request-Id', existingId);

      const request = new Request('https://example.com/api/test', { headers });

      const result = getOrCreateRequestId(request);

      expect(result).toBe(existingId);
    });

    it('given request without X-Request-Id header, should generate new ID', () => {
      const request = new Request('https://example.com/api/test');

      const result = getOrCreateRequestId(request);

      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('given request with invalid X-Request-Id header, should generate new ID', () => {
      const headers = new Headers();
      headers.set('X-Request-Id', '<script>alert(1)</script>');

      const request = new Request('https://example.com/api/test', { headers });

      const result = getOrCreateRequestId(request);

      expect(result).not.toBe('<script>alert(1)</script>');
      expect(isValidRequestId(result)).toBe(true);
    });

    it('given request with empty X-Request-Id header, should generate new ID', () => {
      const headers = new Headers();
      headers.set('X-Request-Id', '');

      const request = new Request('https://example.com/api/test', { headers });

      const result = getOrCreateRequestId(request);

      expect(result.length).toBeGreaterThan(0);
    });

    it('generated IDs should be unique', () => {
      const request1 = new Request('https://example.com/api/test');
      const request2 = new Request('https://example.com/api/test');

      const id1 = getOrCreateRequestId(request1);
      const id2 = getOrCreateRequestId(request2);

      expect(id1).not.toBe(id2);
    });

    it('given lowercase x-request-id header, should still extract ID', () => {
      const existingId = 'incoming-lowercase-id-456';
      const headers = new Headers();
      headers.set('x-request-id', existingId);

      const request = new Request('https://example.com/api/test', { headers });

      const result = getOrCreateRequestId(request);

      expect(result).toBe(existingId);
    });
  });
});
