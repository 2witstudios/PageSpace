import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getMaxFileSizeBytes } from '../upload-multer-config';

const MB = 1024 * 1024;
const BUSINESS_TIER_MAX_MB = 100;

describe('getMaxFileSizeBytes', () => {
  const original = process.env.STORAGE_MAX_FILE_SIZE_MB;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.STORAGE_MAX_FILE_SIZE_MB;
    } else {
      process.env.STORAGE_MAX_FILE_SIZE_MB = original;
    }
  });

  it('given no STORAGE_MAX_FILE_SIZE_MB env var, should default to 100MB (max business tier)', () => {
    delete process.env.STORAGE_MAX_FILE_SIZE_MB;
    expect(getMaxFileSizeBytes()).toBe(BUSINESS_TIER_MAX_MB * MB);
  });

  it('given STORAGE_MAX_FILE_SIZE_MB=50, should cap at 50MB', () => {
    process.env.STORAGE_MAX_FILE_SIZE_MB = '50';
    expect(getMaxFileSizeBytes()).toBe(50 * MB);
  });

  it('given STORAGE_MAX_FILE_SIZE_MB=200, should use 200MB', () => {
    process.env.STORAGE_MAX_FILE_SIZE_MB = '200';
    expect(getMaxFileSizeBytes()).toBe(200 * MB);
  });

  it('given STORAGE_MAX_FILE_SIZE_MB is non-numeric, should fall back to 100MB default', () => {
    process.env.STORAGE_MAX_FILE_SIZE_MB = 'invalid';
    expect(getMaxFileSizeBytes()).toBe(BUSINESS_TIER_MAX_MB * MB);
  });

  it('given STORAGE_MAX_FILE_SIZE_MB=0, should fall back to 100MB default', () => {
    process.env.STORAGE_MAX_FILE_SIZE_MB = '0';
    expect(getMaxFileSizeBytes()).toBe(BUSINESS_TIER_MAX_MB * MB);
  });
});
