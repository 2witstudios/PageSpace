/**
 * Unit tests for the pure backup-freshness assessment.
 *
 * These encode the two production faults that went undetected for 44 days
 * (2026-06-26 → 2026-08-08): a backup job that stopped producing objects, and
 * the GDPR #956 requirement that whatever it does produce is encrypted at rest.
 */

// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  assessBackupFreshness,
  resolveBackupMaxAgeHours,
  DEFAULT_BACKUP_MAX_AGE_HOURS,
  type BackupObject,
} from '../backup-freshness';

const NOW = new Date('2026-08-08T12:00:00.000Z');

function obj(key: string, hoursAgo: number, size = 458_444_832): BackupObject {
  return {
    key,
    lastModified: new Date(NOW.getTime() - hoursAgo * 3_600_000),
    size,
  };
}

const assess = (objects: BackupObject[], maxAgeHours = 36) =>
  assessBackupFreshness({ objects, now: NOW, maxAgeHours });

describe('assessBackupFreshness', () => {
  it('passes a recent encrypted non-empty dump', () => {
    const result = assess([obj('db-backups/pagespace-2026-08-08.dump.enc', 11.5)]);

    expect(result.ok).toBe(true);
    expect(result.reason).toBe('fresh');
    expect(result.encrypted).toBe(true);
    expect(result.ageHours).toBe(11.5);
    expect(result.newest?.key).toBe('db-backups/pagespace-2026-08-08.dump.enc');
  });

  it('picks the newest object by lastModified, not by listing order', () => {
    const result = assess([
      obj('db-backups/pagespace-2026-06-25.dump.enc', 1056),
      obj('db-backups/pagespace-2026-08-08.dump.enc', 2),
      obj('db-backups/pagespace-2026-07-01.dump.enc', 900),
    ]);

    expect(result.ok).toBe(true);
    expect(result.newest?.key).toBe('db-backups/pagespace-2026-08-08.dump.enc');
    expect(result.ageHours).toBe(2);
  });

  it('fails when the prefix is empty', () => {
    const result = assess([]);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_objects');
    expect(result.newest).toBeNull();
    expect(result.ageHours).toBeNull();
    expect(result.encrypted).toBe(false);
    expect(result.message).toMatch(/no recoverable dump/i);
  });

  it('fails a dump older than the threshold', () => {
    const result = assess([obj('db-backups/pagespace-2026-08-06.dump.enc', 44)]);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('stale');
    expect(result.ageHours).toBe(44);
    expect(result.maxAgeHours).toBe(36);
    expect(result.message).toContain('44h old');
  });

  it('reproduces the real 44-day outage: newest object is the pre-encryption plaintext dump', () => {
    // The bucket's actual state on 2026-08-08 before the fix: 23 plaintext
    // objects, newest 2026-06-25, 1067h old.
    const result = assess([obj('db-backups/pagespace-2026-06-25.dump', 1067)]);

    expect(result.ok).toBe(false);
    // Stale wins over not_encrypted: "backups stopped" is the headline.
    expect(result.reason).toBe('stale');
    expect(result.encrypted).toBe(false);
    // ...but the plaintext fact must still reach the operator in the message.
    expect(result.message).toMatch(/not encrypted at rest/i);
  });

  it('fails a FRESH but unencrypted dump — removing encryption must not turn the check green', () => {
    const result = assess([obj('db-backups/pagespace-2026-08-08.dump', 2)]);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_encrypted');
    expect(result.encrypted).toBe(false);
    expect(result.message).toMatch(/GDPR #956/);
  });

  it('fails a fresh encrypted object with a zero-byte body', () => {
    const result = assess([obj('db-backups/pagespace-2026-08-08.dump.enc', 2, 0)]);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty_object');
    expect(result.encrypted).toBe(true);
    expect(result.message).toMatch(/ZERO BYTES/);
  });

  it('treats exactly-at-threshold as fresh and just past it as stale', () => {
    expect(assess([obj('db-backups/x.dump.enc', 36)]).ok).toBe(true);
    expect(assess([obj('db-backups/x.dump.enc', 36.01)]).ok).toBe(false);
  });

  it('honours a custom threshold', () => {
    const twoDayOld = [obj('db-backups/pagespace-2026-08-06.dump.enc', 48)];

    expect(assess(twoDayOld, 36).ok).toBe(false);
    expect(assess(twoDayOld, 72).ok).toBe(true);
  });

  it('never leaks anything but keys, sizes and ages into the message', () => {
    const result = assess([obj('db-backups/pagespace-2026-06-25.dump', 1067)]);

    expect(result.message).not.toMatch(/AWS|SECRET|ACCESS_KEY|password|BACKUP_ENCRYPTION_KEY/i);
  });
});

describe('resolveBackupMaxAgeHours', () => {
  it('defaults to 36h, which tolerates exactly one missed daily run', () => {
    expect(DEFAULT_BACKUP_MAX_AGE_HOURS).toBe(36);
    expect(resolveBackupMaxAgeHours(undefined)).toBe(36);
    expect(resolveBackupMaxAgeHours('')).toBe(36);
    expect(resolveBackupMaxAgeHours('   ')).toBe(36);
  });

  it('accepts a valid override', () => {
    expect(resolveBackupMaxAgeHours('12')).toBe(12);
    expect(resolveBackupMaxAgeHours('72.5')).toBe(72.5);
  });

  it('falls back rather than disabling the check on a nonsense value', () => {
    expect(resolveBackupMaxAgeHours('abc')).toBe(36);
    expect(resolveBackupMaxAgeHours('0')).toBe(36);
    expect(resolveBackupMaxAgeHours('-5')).toBe(36);
    expect(resolveBackupMaxAgeHours('Infinity')).toBe(36);
  });
});
