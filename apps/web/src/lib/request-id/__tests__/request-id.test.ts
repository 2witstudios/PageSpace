import { describe, it, expect } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import {
  getOrCreateRequestId,
  isValidRequestId,
  REQUEST_ID_HEADER,
  createRequestId,
} from '../request-id';

describe('request-id', () => {
  describe('REQUEST_ID_HEADER', () => {
    it('given header constant, should be X-Request-Id', () => {
      expect(REQUEST_ID_HEADER).toBe('X-Request-Id');
    });
  });

  describe('isValidRequestId', () => {
    it('given a valid CUID2, should return true', () => {
      const validId = createId();
      expect(isValidRequestId(validId)).toBe(true);
    });

    it('given a UUID, should return false', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      expect(isValidRequestId(uuid)).toBe(false);
    });

    it('given an arbitrary string, should return false', () => {
      expect(isValidRequestId('req-abc123-xyz789')).toBe(false);
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

    it('given XSS payload, should return false', () => {
      expect(isValidRequestId('<script>alert(1)</script>')).toBe(false);
    });
  });

  describe('getOrCreateRequestId', () => {
    it('given request with valid CUID2 header, should return that ID', () => {
      const existingId = createId();
      const headers = new Headers();
      headers.set('X-Request-Id', existingId);

      const request = new Request('https://example.com/api/test', { headers });

      const result = getOrCreateRequestId(request);

      expect(result).toBe(existingId);
    });

    it('given request without header, should generate new CUID2', () => {
      const request = new Request('https://example.com/api/test');

      const result = getOrCreateRequestId(request);

      expect(isValidRequestId(result)).toBe(true);
    });

    it('given request with invalid header, should generate new CUID2', () => {
      const headers = new Headers();
      headers.set('X-Request-Id', 'not-a-valid-cuid2');

      const request = new Request('https://example.com/api/test', { headers });

      const result = getOrCreateRequestId(request);

      expect(result).not.toBe('not-a-valid-cuid2');
      expect(isValidRequestId(result)).toBe(true);
    });

    it('given request with empty header, should generate new CUID2', () => {
      const headers = new Headers();
      headers.set('X-Request-Id', '');

      const request = new Request('https://example.com/api/test', { headers });

      const result = getOrCreateRequestId(request);

      expect(isValidRequestId(result)).toBe(true);
    });

    it('given multiple requests, should generate unique IDs', () => {
      const request1 = new Request('https://example.com/api/test');
      const request2 = new Request('https://example.com/api/test');

      const id1 = getOrCreateRequestId(request1);
      const id2 = getOrCreateRequestId(request2);

      expect(id1).not.toBe(id2);
    });
  });

  describe('createRequestId', () => {
    it('should generate valid CUID2', () => {
      const id = createRequestId();
      expect(isValidRequestId(id)).toBe(true);
    });
  });
});
