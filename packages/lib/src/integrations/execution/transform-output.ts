/**
 * Pure Output Transform Functions
 *
 * Transforms API responses according to configured rules.
 * These are PURE functions - no side effects, deterministic output.
 */

import type { OutputTransform } from '../types';

/**
 * Simple JSONPath-like extraction.
 * Supports: $.field, $.nested.field, $.array[0], $.array[*].field
 */
export const extractPath = (data: unknown, path: string): unknown => {
  if (!path.startsWith('$.')) {
    return data;
  }

  const parts = path.slice(2).split('.');
  let current: unknown = data;

  for (let i = 0; i < parts.length; i++) {
    if (current === null || current === undefined) {
      return null;
    }

    const part = parts[i];

    // Handle array indexing: array[0] or array[*]
    const arrayMatch = part.match(/^(\w+)\[(\d+|\*)\]$/);
    if (arrayMatch) {
      const [, key, index] = arrayMatch;
      const obj = current as Record<string, unknown>;
      const arr = obj[key];

      if (!Array.isArray(arr)) {
        return null;
      }

      if (index === '*') {
        // If there are more parts after wildcard, map over elements
        const remainingPath = parts.slice(i + 1).join('.');
        if (remainingPath) {
          return arr.map((item) => extractPath(item, '$.' + remainingPath));
        }
        // Otherwise return the array
        current = arr;
      } else {
        current = arr[parseInt(index, 10)];
      }
    } else {
      // Regular property access
      current = (current as Record<string, unknown>)[part];
    }
  }

  return current;
};

/**
 * Apply field mapping to an object.
 */
export const applyMapping = (
  data: unknown,
  mapping: Record<string, string>
): unknown => {
  if (data === null || data === undefined) {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => applyMapping(item, mapping));
  }

  if (typeof data !== 'object') {
    return data;
  }

  const source = data as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [targetKey, sourceKey] of Object.entries(mapping)) {
    result[targetKey] = source[sourceKey];
  }

  return result;
};

/**
 * Truncate string values to maxLength.
 */
export const truncateStrings = (data: unknown, maxLength: number): unknown => {
  if (typeof data === 'string') {
    return data.length > maxLength ? data.slice(0, maxLength) + '...' : data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => truncateStrings(item, maxLength));
  }

  if (data !== null && typeof data === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = truncateStrings(value, maxLength);
    }
    return result;
  }

  return data;
};

/**
 * Transform API response according to configuration.
 */
export const transformOutput = (
  response: unknown,
  transform?: OutputTransform
): unknown => {
  if (!transform) {
    return response;
  }

  let result = response;

  // Apply extraction
  if (transform.extract) {
    result = extractPath(result, transform.extract);
  }

  // Apply mapping
  if (transform.mapping) {
    result = applyMapping(result, transform.mapping);
  }

  // Apply truncation
  if (transform.maxLength) {
    result = truncateStrings(result, transform.maxLength);
  }

  return result;
};
