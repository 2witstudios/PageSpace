import { scrypt, randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

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

  if (parts.length !== 4) {
    throw new Error('Invalid encrypted text format. Expected 4 colon-separated parts (salt:iv:authTag:ciphertext).');
  }

  try {
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
