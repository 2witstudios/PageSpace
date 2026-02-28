import { describe, it, expect, vi } from 'vitest';

// Mock dependencies to avoid resolution errors (maskEmail doesn't need DB)
vi.mock('@pagespace/db', () => ({}));
vi.mock('drizzle-orm', () => ({}));

import { maskEmail } from '../index';

describe('maskEmail', () => {
  it('masks standard email addresses', () => {
    expect(maskEmail('john@example.com')).toBe('jo***@example.com');
  });

  it('masks short local parts', () => {
    expect(maskEmail('j@example.com')).toBe('j***@example.com');
  });

  it('masks two-char local parts', () => {
    expect(maskEmail('ab@example.com')).toBe('ab***@example.com');
  });

  it('limits visible characters to 2', () => {
    expect(maskEmail('longusername@example.com')).toBe('lo***@example.com');
  });

  it('returns fallback for invalid email without @', () => {
    expect(maskEmail('invalid')).toBe('***@***');
  });

  it('returns fallback for empty string', () => {
    expect(maskEmail('')).toBe('***@***');
  });

  it('preserves the domain', () => {
    expect(maskEmail('test@my-company.co.uk')).toBe('te***@my-company.co.uk');
  });
});
