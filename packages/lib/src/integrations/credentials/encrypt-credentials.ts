/**
 * Credential Encryption Utilities
 *
 * Wrapper functions for encrypting and decrypting credential objects
 * used by integration connections. Uses the existing AES-256-GCM
 * encryption utilities.
 *
 * These functions handle Record<string, string> credential objects,
 * encrypting/decrypting each value while preserving keys.
 */

import { encrypt, decrypt } from '../../encryption/encryption-utils';

/**
 * Encrypt all values in a credentials object.
 *
 * @param credentials - Plain text credentials as key-value pairs
 * @returns Encrypted credentials with same keys, encrypted values
 */
export const encryptCredentials = async (
  credentials: Record<string, string>
): Promise<Record<string, string>> => {
  const entries = Object.entries(credentials);

  if (entries.length === 0) {
    return {};
  }

  const encryptedEntries = await Promise.all(
    entries.map(async ([key, value]) => {
      const encryptedValue = await encrypt(value);
      return [key, encryptedValue] as const;
    })
  );

  return Object.fromEntries(encryptedEntries);
};

/**
 * Decrypt all values in an encrypted credentials object.
 *
 * @param encryptedCredentials - Encrypted credentials as key-value pairs
 * @returns Decrypted credentials with same keys, plain text values
 */
export const decryptCredentials = async (
  encryptedCredentials: Record<string, string>
): Promise<Record<string, string>> => {
  const entries = Object.entries(encryptedCredentials);

  if (entries.length === 0) {
    return {};
  }

  const decryptedEntries = await Promise.all(
    entries.map(async ([key, value]) => {
      const decryptedValue = await decrypt(value);
      return [key, decryptedValue] as const;
    })
  );

  return Object.fromEntries(decryptedEntries);
};
