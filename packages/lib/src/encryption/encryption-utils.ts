import { scrypt, randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const KEY_LENGTH = 32;

/**
 * Fixed, non-secret salt for deriving the process-wide master AES key from
 * ENCRYPTION_KEY. Per-record uniqueness comes entirely from the random IV
 * (see `encrypt`), not from this salt, so it must stay constant: every
 * process needs to derive the identical master key from the same
 * ENCRYPTION_KEY to read ciphertext written by any other process.
 */
const MASTER_KEY_SALT = Buffer.from('pagespace:encryption-utils:master-key:v1', 'utf8');

function getEncryptionKey(): string {
  const masterKey = process.env.ENCRYPTION_KEY;
  if (!masterKey) {
    throw new Error('ENCRYPTION_KEY environment variable is required');
  }
  if (masterKey.length < 32) {
    throw new Error('ENCRYPTION_KEY must be at least 32 characters long');
  }
  return masterKey;
}

// ---------------------------------------------------------------------------
// Functional core — pure envelope parse/build + crypto primitives, no I/O.
// ---------------------------------------------------------------------------

interface LegacyEnvelope {
  format: 'legacy';
  salt: Buffer;
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

interface FastEnvelope {
  format: 'fast';
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

type CipherEnvelope = LegacyEnvelope | FastEnvelope;

/**
 * Parses the colon-separated envelope. 3 parts (`iv:authTag:ciphertext`) is
 * the current format, keyed by the memoized master key. 4 parts
 * (`salt:iv:authTag:ciphertext`) is the legacy format from before this
 * expand/contract change, which still needs a fresh per-record scrypt
 * derivation. This is an intentional format-version dispatch, not a guess.
 */
function parseEnvelope(encryptedText: string): CipherEnvelope {
  const parts = encryptedText.split(':');

  if (parts.length === 3) {
    const [ivHex, authTagHex, ciphertextHex] = parts;
    return {
      format: 'fast',
      iv: Buffer.from(ivHex, 'hex'),
      authTag: Buffer.from(authTagHex, 'hex'),
      ciphertext: Buffer.from(ciphertextHex, 'hex'),
    };
  }

  if (parts.length === 4) {
    const [saltHex, ivHex, authTagHex, ciphertextHex] = parts;
    return {
      format: 'legacy',
      salt: Buffer.from(saltHex, 'hex'),
      iv: Buffer.from(ivHex, 'hex'),
      authTag: Buffer.from(authTagHex, 'hex'),
      ciphertext: Buffer.from(ciphertextHex, 'hex'),
    };
  }

  throw new Error(
    'Invalid encrypted text format. Expected "iv:authTag:ciphertext" or legacy "salt:iv:authTag:ciphertext".',
  );
}

/** Builds the current envelope string: `iv:authTag:ciphertext` (no salt). */
function buildEnvelope(iv: Buffer, authTag: Buffer, ciphertext: Buffer): string {
  return [iv.toString('hex'), authTag.toString('hex'), ciphertext.toString('hex')].join(':');
}

function encryptWithKey(key: Buffer, iv: Buffer, plaintext: string): { ciphertext: Buffer; authTag: Buffer } {
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, authTag: cipher.getAuthTag() };
}

function decryptWithKey(key: Buffer, iv: Buffer, authTag: Buffer, ciphertext: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Imperative shell — env reads + scrypt calls, memoized where it's safe to be.
// ---------------------------------------------------------------------------

/** One-time derivation of the shared master key from ENCRYPTION_KEY. */
async function deriveMasterKey(masterKeySecret: string): Promise<Buffer> {
  return (await scryptAsync(masterKeySecret, MASTER_KEY_SALT, KEY_LENGTH)) as Buffer;
}

/** Legacy per-record derivation — unavoidable for old ciphertext, one scrypt call per decrypt. */
async function deriveLegacyKey(salt: Buffer): Promise<Buffer> {
  return (await scryptAsync(getEncryptionKey(), salt, KEY_LENGTH)) as Buffer;
}

/**
 * Lazy-once async memoization via closure: computes on first call and caches
 * the resolved value for every call after. A rejected attempt clears the
 * cache so a later call (e.g. once ENCRYPTION_KEY is fixed) retries instead
 * of failing forever.
 */
function memoizeAsyncOnce<T>(compute: () => Promise<T>): { get: () => Promise<T>; reset: () => void } {
  let pending: Promise<T> | null = null;
  return {
    get: () => {
      if (pending === null) {
        pending = compute().catch((error) => {
          pending = null;
          throw error;
        });
      }
      return pending;
    },
    reset: () => {
      pending = null;
    },
  };
}

const masterKeyCache = memoizeAsyncOnce(() => deriveMasterKey(getEncryptionKey()));

async function getMasterKey(): Promise<Buffer> {
  return masterKeyCache.get();
}

/**
 * Test-only seam: clears the memoized master key so tests that mutate
 * `ENCRYPTION_KEY` mid-suite can force a fresh derivation instead of reusing
 * a key an earlier test already cached.
 */
export function __resetMasterKeyCacheForTests(): void {
  masterKeyCache.reset();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encrypts a plaintext string (e.g., an API key) with AES-256-GCM. The
 * master key is derived from ENCRYPTION_KEY once per process and reused;
 * per-record uniqueness comes from a fresh random IV on every call.
 * @returns The encrypted string, formatted as "iv:authTag:ciphertext".
 */
export async function encrypt(text: string): Promise<string> {
  if (!text || typeof text !== 'string') {
    throw new Error('Text to encrypt must be a non-empty string');
  }

  try {
    const key = await getMasterKey();
    const iv = randomBytes(IV_LENGTH);
    const { ciphertext, authTag } = encryptWithKey(key, iv, text);
    return buildEnvelope(iv, authTag, ciphertext);
  } catch (error) {
    throw new Error(`Encryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Decrypts a string produced by `encrypt`, or a legacy "salt:iv:authTag:ciphertext"
 * value from before the memoized-master-key format change.
 */
export async function decrypt(encryptedText: string): Promise<string> {
  if (!encryptedText || typeof encryptedText !== 'string') {
    throw new Error('Encrypted text must be a non-empty string');
  }

  const envelope = parseEnvelope(encryptedText);

  try {
    const key = envelope.format === 'fast' ? await getMasterKey() : await deriveLegacyKey(envelope.salt);
    return decryptWithKey(key, envelope.iv, envelope.authTag, envelope.ciphertext);
  } catch (error) {
    throw new Error(`Decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
