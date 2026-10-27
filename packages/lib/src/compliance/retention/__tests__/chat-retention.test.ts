import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CHAT_SOFT_DELETE_RETENTION_DAYS,
  resolveChatRetentionDays,
  computeChatRetentionCutoff,
  isChatRecordExpired,
} from '../chat-retention';

describe('resolveChatRetentionDays (#974)', () => {
  it('returns the default when unset', () => {
    expect(resolveChatRetentionDays(undefined)).toBe(DEFAULT_CHAT_SOFT_DELETE_RETENTION_DAYS);
  });

  it('parses a valid positive integer', () => {
    expect(resolveChatRetentionDays('7')).toBe(7);
  });

  it('floors fractional values', () => {
    expect(resolveChatRetentionDays('14.9')).toBe(14);
  });

  it('falls back on invalid / non-positive input', () => {
    expect(resolveChatRetentionDays('abc')).toBe(DEFAULT_CHAT_SOFT_DELETE_RETENTION_DAYS);
    expect(resolveChatRetentionDays('0')).toBe(DEFAULT_CHAT_SOFT_DELETE_RETENTION_DAYS);
    expect(resolveChatRetentionDays('-5')).toBe(DEFAULT_CHAT_SOFT_DELETE_RETENTION_DAYS);
  });
});

describe('computeChatRetentionCutoff', () => {
  it('returns retentionDays before now', () => {
    const now = new Date('2026-06-30T00:00:00.000Z');
    expect(computeChatRetentionCutoff(now, 30).toISOString()).toBe('2026-05-31T00:00:00.000Z');
  });

  it('is referentially transparent and non-mutating', () => {
    const now = new Date('2026-06-30T00:00:00.000Z');
    const before = now.getTime();
    expect(computeChatRetentionCutoff(now, 10).toISOString()).toBe(
      computeChatRetentionCutoff(now, 10).toISOString(),
    );
    expect(now.getTime()).toBe(before);
  });
});

describe('isChatRecordExpired', () => {
  const cutoff = new Date('2026-06-01T00:00:00.000Z');

  it('expires records created before the cutoff', () => {
    expect(isChatRecordExpired(new Date('2026-05-31T23:59:59.000Z'), cutoff)).toBe(true);
  });

  it('retains records created at or after the cutoff (exclusive boundary)', () => {
    expect(isChatRecordExpired(cutoff, cutoff)).toBe(false);
    expect(isChatRecordExpired(new Date('2026-06-02T00:00:00.000Z'), cutoff)).toBe(false);
  });
});
