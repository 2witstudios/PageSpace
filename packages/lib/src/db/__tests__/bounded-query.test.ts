import { describe, it, expect } from 'vitest';
import { parseBoundedIntParam, resolveBoundedLimit } from '../bounded-query';

describe('parseBoundedIntParam', () => {
  it('should return the default when rawValue is null', () => {
    expect(parseBoundedIntParam(null, { defaultValue: 10 })).toBe(10);
  });

  it('should return the default when rawValue is an empty string', () => {
    expect(parseBoundedIntParam('', { defaultValue: 10 })).toBe(10);
  });

  it('should return the default when rawValue does not parse to a finite number', () => {
    expect(parseBoundedIntParam('not-a-number', { defaultValue: 10 })).toBe(10);
  });

  it('should return the parsed value when it is within bounds', () => {
    expect(parseBoundedIntParam('42', { defaultValue: 10 })).toBe(42);
  });

  it('should clamp the default itself to the supplied min when no min is given for the raw value', () => {
    expect(parseBoundedIntParam(null, { defaultValue: -5, min: 0 })).toBe(0);
  });

  it('should clamp the default itself to the supplied max', () => {
    expect(parseBoundedIntParam(null, { defaultValue: 500, max: 100 })).toBe(100);
  });

  it('should clamp a parsed value below the supplied min', () => {
    expect(parseBoundedIntParam('-5', { defaultValue: 10, min: 0 })).toBe(0);
  });

  it('should clamp a parsed value above the supplied max', () => {
    expect(parseBoundedIntParam('999', { defaultValue: 10, max: 100 })).toBe(100);
  });
});

describe('resolveBoundedLimit', () => {
  it('should apply the policy default when the caller omits a limit', () => {
    expect(resolveBoundedLimit(null, { defaultValue: 25, max: 100 })).toBe(25);
  });

  it('should clamp to the policy max when the caller requests a limit above it', () => {
    expect(resolveBoundedLimit('5000', { defaultValue: 25, max: 100 })).toBe(100);
  });

  it('should clamp to 1 when the caller requests 0', () => {
    expect(resolveBoundedLimit('0', { defaultValue: 25, max: 100 })).toBe(1);
  });

  it('should clamp to 1 when the caller requests a negative limit', () => {
    expect(resolveBoundedLimit('-10', { defaultValue: 25, max: 100 })).toBe(1);
  });

  it('should clamp to 1 when the caller requests a non-numeric limit and the default is 0', () => {
    expect(resolveBoundedLimit('not-a-number', { defaultValue: 0, max: 100 })).toBe(1);
  });

  it('should pass a valid in-range limit through unchanged', () => {
    expect(resolveBoundedLimit('50', { defaultValue: 25, max: 100 })).toBe(50);
  });

  it('should honor an explicit min above 1 when provided', () => {
    expect(resolveBoundedLimit('3', { defaultValue: 25, max: 100, min: 5 })).toBe(5);
  });
});
