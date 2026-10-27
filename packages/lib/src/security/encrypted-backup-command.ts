/**
 * Pure builder for the encrypted pg_dump backup pipeline (GDPR #956).
 *
 * Canonical spec mirrored by PageSpace-Deploy/fly/backup/backup.sh. Returns the
 * exact argv of each pipeline stage so it can be unit-tested without running
 * pg_dump. The pipeline streams end-to-end so plaintext is never written to
 * disk: pg_dump (custom format) → openssl AES-256 (key from env) → aws s3 cp -.
 */

export interface BackupCommandOptions {
  databaseUrl: string;
  bucket: string;
  /** Destination object key — MUST end in `.enc` to flag encryption at rest. */
  s3Key: string;
  endpointUrl: string;
  /** Name of the env var holding the AES passphrase. Default BACKUP_ENCRYPTION_KEY. */
  encryptionKeyEnvVar?: string;
}

export interface BackupPipeline {
  /** argv for each piped stage, in order. */
  stages: string[][];
  encrypted: boolean;
  writesPlaintextToDisk: boolean;
}

export function buildEncryptedBackupPipeline(opts: BackupCommandOptions): BackupPipeline {
  if (!opts.s3Key.endsWith('.enc')) {
    throw new Error(`Backup key must end in .enc (encrypted at rest); got "${opts.s3Key}"`);
  }
  const keyVar = opts.encryptionKeyEnvVar ?? 'BACKUP_ENCRYPTION_KEY';

  const stages: string[][] = [
    // -Fc custom format, to stdout (no -f file → nothing written to disk).
    ['pg_dump', '-Fc', opts.databaseUrl],
    // Authenticated key derivation (PBKDF2), key read from the environment.
    ['openssl', 'enc', '-aes-256-cbc', '-pbkdf2', '-salt', '-pass', `env:${keyVar}`],
    // Read ciphertext from stdin (`-`) and stream straight to object storage.
    ['aws', 's3', 'cp', '-', `s3://${opts.bucket}/${opts.s3Key}`, '--endpoint-url', opts.endpointUrl],
  ];

  return { stages, encrypted: true, writesPlaintextToDisk: false };
}
