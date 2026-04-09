import { describe, it, expect } from 'vitest';
import { serializeDates, jsonResponse } from '../api-utils';

describe('api-utils', () => {
  describe('serializeDates', () => {
    it('given null, should return null', () => {
      expect(serializeDates(null)).toBeNull();
    });

    it('given undefined, should return undefined', () => {
      expect(serializeDates(undefined)).toBeUndefined();
    });

    it('given a Date object, should return an ISO8601 string', () => {
      const date = new Date('2025-01-15T10:30:00.000Z');
      const result = serializeDates(date);
      expect(result).toBe('2025-01-15T10:30:00.000Z');
    });

    it('given a string primitive, should return it unchanged', () => {
      expect(serializeDates('hello')).toBe('hello');
    });

    it('given a number primitive, should return it unchanged', () => {
      expect(serializeDates(42)).toBe(42);
    });

    it('given a boolean primitive, should return it unchanged', () => {
      expect(serializeDates(true)).toBe(true);
      expect(serializeDates(false)).toBe(false);
    });

    it('given a flat object with a Date value, should serialize the Date', () => {
      const date = new Date('2024-06-01T00:00:00.000Z');
      const result = serializeDates({ createdAt: date, title: 'Test' });
      expect(result).toEqual({ createdAt: '2024-06-01T00:00:00.000Z', title: 'Test' });
    });

    it('given a flat object with no Date values, should return it unchanged', () => {
      const obj = { id: 1, name: 'page', active: true };
      expect(serializeDates(obj)).toEqual(obj);
    });

    it('given a nested object with Dates, should serialize all Dates recursively', () => {
      const inner = new Date('2023-03-05T12:00:00.000Z');
      const outer = new Date('2023-03-06T12:00:00.000Z');
      const input = {
        outer: outer,
        nested: {
          inner: inner,
          label: 'deep',
        },
      };
      const result = serializeDates(input);
      expect(result).toEqual({
        outer: '2023-03-06T12:00:00.000Z',
        nested: {
          inner: '2023-03-05T12:00:00.000Z',
          label: 'deep',
        },
      });
    });

    it('given an array of primitives, should return them unchanged', () => {
      expect(serializeDates([1, 'two', true])).toEqual([1, 'two', true]);
    });

    it('given an array containing Date objects, should serialize each Date', () => {
      const d1 = new Date('2025-01-01T00:00:00.000Z');
      const d2 = new Date('2025-06-15T08:00:00.000Z');
      const result = serializeDates([d1, d2]);
      expect(result).toEqual(['2025-01-01T00:00:00.000Z', '2025-06-15T08:00:00.000Z']);
    });

    it('given an array of objects with Dates, should serialize Dates within each element', () => {
      const date = new Date('2024-12-31T23:59:59.999Z');
      const input = [
        { id: 1, updatedAt: date },
        { id: 2, updatedAt: null },
      ];
      const result = serializeDates(input);
      expect(result).toEqual([
        { id: 1, updatedAt: '2024-12-31T23:59:59.999Z' },
        { id: 2, updatedAt: null },
      ]);
    });

    it('given an object with null and undefined values, should preserve them', () => {
      const input = { a: null, b: undefined, c: 'keep' };
      const result = serializeDates(input);
      expect(result).toEqual({ a: null, b: undefined, c: 'keep' });
    });

    it('given deeply nested arrays and objects with Dates, should handle full recursion', () => {
      const date = new Date('2020-01-01T00:00:00.000Z');
      const input = {
        pages: [
          { title: 'p1', dates: [date] },
        ],
      };
      const result = serializeDates(input);
      expect(result).toEqual({
        pages: [
          { title: 'p1', dates: ['2020-01-01T00:00:00.000Z'] },
        ],
      });
    });
  });

  describe('jsonResponse', () => {
    it('given plain data, should return a Response with JSON body', async () => {
      const response = jsonResponse({ id: 1, name: 'test' });
      expect(response).toBeInstanceOf(Response);
      const body = await response.json();
      expect(body).toEqual({ id: 1, name: 'test' });
    });

    it('given data with Dates, should serialize them in the response body', async () => {
      const date = new Date('2025-03-10T15:00:00.000Z');
      const response = jsonResponse({ createdAt: date });
      const body = await response.json();
      expect(body).toEqual({ createdAt: '2025-03-10T15:00:00.000Z' });
    });

    it('given a custom status code via init, should use it', () => {
      const response = jsonResponse({ error: 'not found' }, { status: 404 });
      expect(response.status).toBe(404);
    });

    it('given custom headers via init, should include them', () => {
      const response = jsonResponse({ ok: true }, {
        headers: { 'X-Custom-Header': 'value' },
      });
      expect(response.headers.get('X-Custom-Header')).toBe('value');
    });

    it('given no init, should return a 200 response', () => {
      const response = jsonResponse({ ok: true });
      expect(response.status).toBe(200);
    });

    it('given null data, should return a response with null body', async () => {
      const response = jsonResponse(null);
      const body = await response.json();
      expect(body).toBeNull();
    });
  });
});
