import { scrypt, randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { promisify } from 'util';
import { loggers } from '../logging/logger-config';

const scryptAsync = promisify(scrypt);

// Track ciphertexts that have already triggered deprecation warnings to avoid log spam
const loggedDeprecationWarnings = new Set<string>();

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;

function getEncryptionKey(): string {
  // Validate encryption key exists and is secure
  const masterKey = process.env.ENCRYPTION_KEY;
  if (!masterKey) {
    throw new Error('ENCRYPTION_KEY environment variable is required');
  }
  if (masterKey.length < 32) {
    throw new Error('ENCRYPTION_KEY must be at least 32 characters long');
  }
  return masterKey;
}

// Derive a key from the master key and unique salt per operation.
async function deriveKey(salt: Buffer): Promise<Buffer> {
  try {
    return (await scryptAsync(getEncryptionKey(), salt, KEY_LENGTH)) as Buffer;
  } catch (error) {
    throw new Error(`Key derivation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Detects whether an encrypted string uses the legacy 3-part format.
 *
 * Legacy format: "iv:authTag:ciphertext" (uses static salt from ENCRYPTION_SALT env var)
 * Current format: "salt:iv:authTag:ciphertext" (uses unique per-operation salt)
 *
 * @param encryptedText The encrypted string to check.
 * @returns true if the string uses legacy 3-part format, false for 4-part format or invalid.
 */
export function isLegacyFormat(encryptedText: string): boolean {
  if (!encryptedText || typeof encryptedText !== 'string') {
    return false;
  }

  const parts = encryptedText.split(':');
  return parts.length === 3;
}

/**
 * Encrypts a plaintext string (e.g., an API key).
 * @param text The plaintext to encrypt.
 * @returns A promise that resolves to the encrypted string, formatted as "salt:iv:authtag:ciphertext".
 */
export async function encrypt(text: string): Promise<string> {
  if (!text || typeof text !== 'string') {
    throw new Error('Text to encrypt must be a non-empty string');
  }
  
  try {
    // Generate unique salt and IV for this encryption operation
    const salt = randomBytes(SALT_LENGTH);
    const iv = randomBytes(IV_LENGTH);
    
    // Derive key using the unique salt
    const key = await deriveKey(salt);
    const cipher = createCipheriv(ALGORITHM, key, iv);

    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return `${salt.toString('hex')}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  } catch (error) {
    throw new Error(`Encryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Decrypts an encrypted string.
 * @param encryptedText The encrypted string, formatted as "salt:iv:authtag:ciphertext".
 * @returns A promise that resolves to the decrypted plaintext string.
 */
export async function decrypt(encryptedText: string): Promise<string> {
  if (!encryptedText || typeof encryptedText !== 'string') {
    throw new Error('Encrypted text must be a non-empty string');
  }
  
  const parts = encryptedText.split(':');
  
  // Support both old format (3 parts) and new format (4 parts) for backward compatibility
  if (parts.length === 3) {
    // Legacy format: "iv:authtag:ciphertext" (uses static salt)
    return await decryptLegacy(encryptedText);
  } else if (parts.length === 4) {
    // New format: "salt:iv:authtag:ciphertext"
    return await decryptNew(encryptedText);
  } else {
    throw new Error('Invalid encrypted text format. Expected either 3 or 4 colon-separated parts.');
  }
}

// Legacy decrypt function for backward compatibility
async function decryptLegacy(encryptedText: string): Promise<string> {
  // Emit deprecation warning (deduplicated by ciphertext identifier)
  const ciphertextId = encryptedText.substring(0, 16) + '...' + encryptedText.slice(-8);
  if (!loggedDeprecationWarnings.has(ciphertextId)) {
    loggedDeprecationWarnings.add(ciphertextId);
    loggers.security.warn(
      'DEPRECATION: Legacy encryption format detected. This format uses a static salt and will be removed in a future version.',
      {
        ciphertextId,
        format: 'legacy-3-part',
        migration: 'Run the encryption migration script or use reEncrypt() to upgrade to the current 4-part format with unique per-operation salt.'
      }
    );
  }

  try {
    const parts = encryptedText.split(':');
    const [ivHex, authTagHex, encryptedHex] = parts;
    
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');

    // Use legacy static salt for backward compatibility
    const legacySalt = process.env.ENCRYPTION_SALT || 'a-secure-static-salt-for-everyone';
    const key = (await scryptAsync(getEncryptionKey(), legacySalt, KEY_LENGTH)) as Buffer;

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (error) {
    throw new Error(`Legacy decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// New decrypt function with unique salt
async function decryptNew(encryptedText: string): Promise<string> {
  try {
    const parts = encryptedText.split(':');
    const [saltHex, ivHex, authTagHex, encryptedHex] = parts;
    
    const salt = Buffer.from(saltHex, 'hex');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');

    // Derive key using the salt from the encrypted text
    const key = await deriveKey(salt);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (error) {
    throw new Error(`Decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}