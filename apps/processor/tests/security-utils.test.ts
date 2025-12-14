import path from 'path';
import { describe, it, expect } from 'vitest';
import {
  sanitizeExtension,
  resolvePathWithin,
  normalizeIdentifier,
  DEFAULT_EXTENSION,
  DEFAULT_IMAGE_EXTENSION,
} from '../src/utils/security';

describe('sanitizeExtension', () => {
  it('keeps safe extension', () => {
    const ext = sanitizeExtension('photo.PNG', DEFAULT_IMAGE_EXTENSION);
    expect(ext).toBe('.png');
  });

  it('falls back on unsafe names', () => {
    const ext = sanitizeExtension('../etc/passwd', DEFAULT_EXTENSION);
    expect(ext).toBe(DEFAULT_EXTENSION);
  });
});

describe('resolvePathWithin', () => {
  it('allows safe relative paths', () => {
    const base = path.join(process.cwd(), 'tmp', 'security');
    const resolved = resolvePathWithin(base, 'uploads', 'file.txt');
    expect(resolved).toBeTruthy();
    expect(resolved!.startsWith(path.resolve(base) + path.sep)).toBe(true);
  });

  it('rejects traversal', () => {
    const base = path.join(process.cwd(), 'tmp', 'security');
    const resolved = resolvePathWithin(base, '..', 'evil.txt');
    expect(resolved).toBeNull();
  });
});

describe('normalizeIdentifier', () => {
  it('trims and accepts safe values', () => {
    const id = normalizeIdentifier('  user_123  ');
    expect(id).toBe('user_123');
  });

  it('rejects unsafe values', () => {
    const id = normalizeIdentifier('../etc/passwd');
    expect(id).toBeNull();
  });
});
