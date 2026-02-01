/**
 * Pure Output Transform Tests
 */

import { describe, it, expect } from 'vitest';
import { transformOutput, extractPath, applyMapping, truncateStrings } from './transform-output';

describe('extractPath', () => {
  it('given extract with JSONPath expression, should extract matching value', () => {
    const data = { user: { name: 'Alice', email: 'alice@example.com' } };

    expect(extractPath(data, '$.user.name')).toBe('Alice');
    expect(extractPath(data, '$.user.email')).toBe('alice@example.com');
  });

  it('given nested path, should traverse correctly', () => {
    const data = { a: { b: { c: { d: 'deep value' } } } };

    expect(extractPath(data, '$.a.b.c.d')).toBe('deep value');
  });

  it('given array index, should extract element', () => {
    const data = { items: ['first', 'second', 'third'] };

    expect(extractPath(data, '$.items[0]')).toBe('first');
    expect(extractPath(data, '$.items[2]')).toBe('third');
  });

  it('given null/undefined in path, should return null gracefully', () => {
    const data = { user: null };

    expect(extractPath(data, '$.user.name')).toBeNull();
    expect(extractPath(null, '$.anything')).toBeNull();
    expect(extractPath(undefined, '$.anything')).toBeNull();
  });

  it('given no path prefix, should return data as-is', () => {
    const data = { key: 'value' };

    expect(extractPath(data, 'not-a-path')).toEqual(data);
  });
});

describe('applyMapping', () => {
  it('given mapping config, should rename fields in output', () => {
    const data = { id: 123, html_url: 'https://example.com', created_at: '2024-01-01' };
    const mapping = { issueId: 'id', url: 'html_url', createdAt: 'created_at' };

    const result = applyMapping(data, mapping);

    expect(result).toEqual({
      issueId: 123,
      url: 'https://example.com',
      createdAt: '2024-01-01',
    });
  });

  it('given array output, should apply mapping to each element', () => {
    const data = [
      { id: 1, name: 'First' },
      { id: 2, name: 'Second' },
    ];
    const mapping = { itemId: 'id', title: 'name' };

    const result = applyMapping(data, mapping);

    expect(result).toEqual([
      { itemId: 1, title: 'First' },
      { itemId: 2, title: 'Second' },
    ]);
  });

  it('given null/undefined, should return as-is', () => {
    expect(applyMapping(null, { a: 'b' })).toBeNull();
    expect(applyMapping(undefined, { a: 'b' })).toBeUndefined();
  });
});

describe('truncateStrings', () => {
  it('given maxLength config, should truncate string values', () => {
    const data = { title: 'This is a very long title that should be truncated' };

    const result = truncateStrings(data, 20);

    expect((result as Record<string, string>).title).toBe('This is a very long ...');
  });

  it('given string shorter than maxLength, should not truncate', () => {
    const data = { title: 'Short' };

    const result = truncateStrings(data, 20);

    expect((result as Record<string, string>).title).toBe('Short');
  });

  it('given nested objects, should truncate recursively', () => {
    const data = {
      user: {
        bio: 'A very long biography that exceeds the limit',
      },
    };

    const result = truncateStrings(data, 15) as Record<string, Record<string, string>>;

    expect(result.user.bio).toBe('A very long bio...');
  });

  it('given array of strings, should truncate each', () => {
    const data = ['short', 'this is a longer string'];

    const result = truncateStrings(data, 10);

    expect(result).toEqual(['short', 'this is a ...']);
  });
});

describe('transformOutput', () => {
  it('given no transform, should return response unchanged', () => {
    const response = { data: 'value' };

    const result = transformOutput(response, undefined);

    expect(result).toEqual(response);
  });

  it('given extract only, should extract value', () => {
    const response = { data: { items: [1, 2, 3] } };

    const result = transformOutput(response, { extract: '$.data.items' });

    expect(result).toEqual([1, 2, 3]);
  });

  it('given mapping only, should apply mapping', () => {
    const response = { id: 1, full_name: 'Test' };

    const result = transformOutput(response, {
      mapping: { itemId: 'id', name: 'full_name' },
    });

    expect(result).toEqual({ itemId: 1, name: 'Test' });
  });

  it('given combined extract and mapping, should apply in order', () => {
    const response = {
      data: {
        user: { id: 123, display_name: 'Alice' },
      },
    };

    const result = transformOutput(response, {
      extract: '$.data.user',
      mapping: { userId: 'id', name: 'display_name' },
    });

    expect(result).toEqual({ userId: 123, name: 'Alice' });
  });

  it('given null/undefined response, should return null gracefully', () => {
    expect(transformOutput(null, { extract: '$.data' })).toBeNull();
    expect(transformOutput(undefined, { extract: '$.data' })).toBeNull();
  });
});
