/**
 * Encrypts a plaintext string (e.g., an API key).
 * @param text The plaintext to encrypt.
 * @returns A promise that resolves to the encrypted string, formatted as "salt:iv:authtag:ciphertext".
 */
export declare function encrypt(text: string): Promise<string>;
/**
 * Decrypts an encrypted string.
 * @param encryptedText The encrypted string, formatted as "salt:iv:authtag:ciphertext".
 * @returns A promise that resolves to the decrypted plaintext string.
 */
export declare function decrypt(encryptedText: string): Promise<string>;
//# sourceMappingURL=encryption-utils.d.ts.map