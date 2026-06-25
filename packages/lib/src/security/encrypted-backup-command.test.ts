/**
 * Encrypted pg_dump backup command spec (GDPR #956).
 *
 * Canonical, unit-testable definition of the backup pipeline implemented by
 * PageSpace-Deploy/fly/backup/backup.sh. Backups must be encrypted at rest with
 * a key sourced from the environment and must never write plaintext to disk —
 * so the pipeline streams pg_dump → openssl AES-256 → `aws s3 cp -` (stdin).
 */
import { describe, it, expect } from 'vitest';
import { buildEncryptedBackupPipeline } from './encrypted-backup-command';

const OPTS = {
  databaseUrl: 'postgres://u:p@h/db',
  bucket: 'pagespace-files',
  s3Key: 'db-backups/pagespace-2026-06-24.dump.enc',
  endpointUrl: 'https://t3.storage.dev',
};

describe('buildEncryptedBackupPipeline', () => {
  it('streams pg_dump → openssl AES-256 → aws s3 cp - (no plaintext on disk)', () => {
    const { stages, writesPlaintextToDisk, encrypted } = buildEncryptedBackupPipeline(OPTS);
    expect(encrypted).toBe(true);
    expect(writesPlaintextToDisk).toBe(false);
    expect(stages).toHaveLength(3);
    expect(stages[0][0]).toBe('pg_dump');
    expect(stages[1][0]).toBe('openssl');
    expect(stages[2].slice(0, 4)).toEqual(['aws', 's3', 'cp', '-']);
  });

  it('encrypts with AES-256 using a key sourced from the environment, not a literal', () => {
    const openssl = buildEncryptedBackupPipeline(OPTS).stages[1].join(' ');
    expect(openssl).toContain('enc');
    expect(openssl).toContain('-aes-256-cbc');
    expect(openssl).toContain('-pbkdf2');
    expect(openssl).toContain('-pass env:BACKUP_ENCRYPTION_KEY');
    // Never embed a raw key on the command line.
    expect(openssl).not.toMatch(/-pass\s+pass:/);
  });

  it('uploads the encrypted object to the requested key on the Tigris endpoint', () => {
    const upload = buildEncryptedBackupPipeline(OPTS).stages[2].join(' ');
    expect(upload).toContain('s3://pagespace-files/db-backups/pagespace-2026-06-24.dump.enc');
    expect(upload).toContain('--endpoint-url https://t3.storage.dev');
  });

  it('allows overriding the key env var name', () => {
    const openssl = buildEncryptedBackupPipeline({ ...OPTS, encryptionKeyEnvVar: 'MY_KEY' }).stages[1].join(' ');
    expect(openssl).toContain('-pass env:MY_KEY');
  });

  it('rejects a non-encrypted .dump key to prevent plaintext-at-rest regressions', () => {
    expect(() => buildEncryptedBackupPipeline({ ...OPTS, s3Key: 'db-backups/x.dump' })).toThrow();
  });
});
