import { describe, it, expect } from 'vitest';
import {
  redactUrlQueryParams,
  sanitizeEndpoint,
  sanitizeIngestPayload,
  truncateString,
} from '../ingest-sanitizer';

describe('redactUrlQueryParams', () => {
  it('strips query parameters from URLs', () => {
    expect(redactUrlQueryParams('/api/pages?token=secret&id=123')).toBe('/api/pages');
  });

  it('returns path unchanged when no query params', () => {
    expect(redactUrlQueryParams('/api/pages')).toBe('/api/pages');
  });

  it('strips fragment identifiers', () => {
    expect(redactUrlQueryParams('/api/pages#section')).toBe('/api/pages');
  });

  it('strips both query params and fragments', () => {
    expect(redactUrlQueryParams('/api/pages?key=val#section')).toBe('/api/pages');
  });

  it('handles empty string', () => {
    expect(redactUrlQueryParams('')).toBe('');
  });

  it('handles full URLs by extracting pathname', () => {
    expect(redactUrlQueryParams('https://example.com/api/test?secret=abc')).toBe('/api/test');
  });
});

describe('sanitizeEndpoint', () => {
  it('normalizes double slashes', () => {
    expect(sanitizeEndpoint('//api//pages//')).toBe('/api/pages/');
  });

  it('truncates excessively long endpoints', () => {
    const longPath = '/api/' + 'a'.repeat(500);
    const result = sanitizeEndpoint(longPath);
    expect(result.length).toBeLessThanOrEqual(256);
  });

  it('removes query parameters', () => {
    expect(sanitizeEndpoint('/api/pages?token=secret')).toBe('/api/pages');
  });

  it('handles undefined', () => {
    expect(sanitizeEndpoint(undefined as unknown as string)).toBe('');
  });
});

describe('truncateString', () => {
  it('returns short strings unchanged', () => {
    expect(truncateString('hello', 10)).toBe('hello');
  });

  it('truncates long strings', () => {
    expect(truncateString('hello world', 5)).toBe('hello');
  });

  it('handles undefined', () => {
    expect(truncateString(undefined, 10)).toBeUndefined();
  });
});

describe('sanitizeIngestPayload', () => {
  it('redacts query params from endpoint', () => {
    const payload = {
      type: 'api-request' as const,
      method: 'GET',
      endpoint: '/api/pages?token=secret',
      statusCode: 200,
      duration: 100,
    };
    const result = sanitizeIngestPayload(payload);
    expect(result.endpoint).toBe('/api/pages');
  });

  it('removes query field from payload', () => {
    const payload = {
      type: 'api-request' as const,
      method: 'GET',
      endpoint: '/api/test',
      statusCode: 200,
      duration: 100,
      query: { token: 'secret', password: '123' },
    };
    const result = sanitizeIngestPayload(payload);
    expect(result.query).toBeUndefined();
  });

  it('truncates long error messages', () => {
    const payload = {
      type: 'api-request' as const,
      method: 'GET',
      endpoint: '/api/test',
      statusCode: 500,
      duration: 100,
      error: 'x'.repeat(2000),
    };
    const result = sanitizeIngestPayload(payload);
    expect(result.error!.length).toBeLessThanOrEqual(1024);
  });

  it('truncates long error stacks', () => {
    const payload = {
      type: 'api-request' as const,
      method: 'GET',
      endpoint: '/api/test',
      statusCode: 500,
      duration: 100,
      errorStack: 'x'.repeat(10000),
    };
    const result = sanitizeIngestPayload(payload);
    expect(result.errorStack!.length).toBeLessThanOrEqual(4096);
  });

  it('truncates long user agents', () => {
    const payload = {
      type: 'api-request' as const,
      method: 'GET',
      endpoint: '/api/test',
      statusCode: 200,
      duration: 100,
      userAgent: 'x'.repeat(1000),
    };
    const result = sanitizeIngestPayload(payload);
    expect(result.userAgent!.length).toBeLessThanOrEqual(512);
  });

  it('clamps negative duration to 0', () => {
    const payload = {
      type: 'api-request' as const,
      method: 'GET',
      endpoint: '/api/test',
      statusCode: 200,
      duration: -5,
    };
    const result = sanitizeIngestPayload(payload);
    expect(result.duration).toBe(0);
  });

  it('clamps excessively large duration', () => {
    const payload = {
      type: 'api-request' as const,
      method: 'GET',
      endpoint: '/api/test',
      statusCode: 200,
      duration: 999999999,
    };
    const result = sanitizeIngestPayload(payload);
    expect(result.duration).toBeLessThanOrEqual(300000);
  });

  it('preserves valid payload fields', () => {
    const payload = {
      type: 'api-request' as const,
      method: 'POST',
      endpoint: '/api/pages',
      statusCode: 201,
      duration: 45,
      userId: 'user-123',
      requestId: 'req-456',
    };
    const result = sanitizeIngestPayload(payload);
    expect(result.method).toBe('POST');
    expect(result.statusCode).toBe(201);
    expect(result.userId).toBe('user-123');
    expect(result.requestId).toBe('req-456');
  });
});
