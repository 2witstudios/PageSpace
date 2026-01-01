import { describe, it, expect, beforeEach, vi } from 'vitest'
import { encrypt, decrypt, isLegacyFormat, reEncrypt, decryptAndMigrate } from '../encryption/encryption-utils'
import { scrypt, randomBytes, createCipheriv } from 'crypto'
import { promisify } from 'util'

const scryptAsync = promisify(scrypt)

/**
 * Helper function to create legacy-format encrypted data for testing.
 * This mimics the old encryption format: "iv:authTag:ciphertext"
 */
async function createLegacyEncrypted(text: string): Promise<string> {
  const ALGORITHM = 'aes-256-gcm'
  const IV_LENGTH = 16
  const KEY_LENGTH = 32

  const masterKey = process.env.ENCRYPTION_KEY!
  const legacySalt = process.env.ENCRYPTION_SALT || 'a-secure-static-salt-for-everyone'

  const iv = randomBytes(IV_LENGTH)
  const key = (await scryptAsync(masterKey, legacySalt, KEY_LENGTH)) as Buffer
  const cipher = createCipheriv(ALGORITHM, key, iv)

  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`
}

describe('encryption-utils', () => {
  const testData = 'sensitive-api-key-12345'
  const longData = 'a'.repeat(10000) // Test large data

  describe('encrypt', () => {
    it('encrypts plaintext successfully', async () => {
      const encrypted = await encrypt(testData)

      expect(encrypted).toBeTruthy()
      expect(typeof encrypted).toBe('string')
      expect(encrypted).not.toBe(testData)
    })

    it('produces unique encrypted outputs for same input', async () => {
      const encrypted1 = await encrypt(testData)
      const encrypted2 = await encrypt(testData)

      // Different salt/IV means different ciphertext
      expect(encrypted1).not.toBe(encrypted2)
    })

    it('produces 4-part colon-separated format (new format)', async () => {
      const encrypted = await encrypt(testData)
      const parts = encrypted.split(':')

      expect(parts.length).toBe(4)
      expect(parts[0]).toBeTruthy() // salt
      expect(parts[1]).toBeTruthy() // iv
      expect(parts[2]).toBeTruthy() // authTag
      expect(parts[3]).toBeTruthy() // ciphertext
    })

    it('encrypts long data successfully', async () => {
      const encrypted = await encrypt(longData)
      expect(encrypted).toBeTruthy()

      const decrypted = await decrypt(encrypted)
      expect(decrypted).toBe(longData)
    })

    it('throws error for empty string', async () => {
      await expect(encrypt('')).rejects.toThrow('Text to encrypt must be a non-empty string')
    })

    it('throws error for non-string input', async () => {
      await expect(encrypt(null as any)).rejects.toThrow('Text to encrypt must be a non-empty string')
      await expect(encrypt(undefined as any)).rejects.toThrow('Text to encrypt must be a non-empty string')
      await expect(encrypt(123 as any)).rejects.toThrow('Text to encrypt must be a non-empty string')
    })

    it('handles special characters', async () => {
      const specialChars = '!@#$%^&*()_+-=[]{}|;:\'",.<>?/~`\n\t\r'
      const encrypted = await encrypt(specialChars)
      const decrypted = await decrypt(encrypted)

      expect(decrypted).toBe(specialChars)
    })

    it('handles unicode characters', async () => {
      const unicode = '你好世界 🌍 مرحبا العالم'
      const encrypted = await encrypt(unicode)
      const decrypted = await decrypt(encrypted)

      expect(decrypted).toBe(unicode)
    })
  })

  describe('decrypt', () => {
    it('decrypts encrypted data successfully (new format)', async () => {
      const encrypted = await encrypt(testData)
      const decrypted = await decrypt(encrypted)

      expect(decrypted).toBe(testData)
    })

    it('maintains data integrity for multiple encrypt/decrypt cycles', async () => {
      let current = testData

      for (let i = 0; i < 5; i++) {
        const encrypted = await encrypt(current)
        current = await decrypt(encrypted)
      }

      expect(current).toBe(testData)
    })

    it('handles legacy 3-part format for backward compatibility', async () => {
      // We can't easily create a legacy token without exposing internals,
      // but we can test that the parser handles 3-part format
      const fakeLegacy = 'iv:authTag:ciphertext'

      // This will fail decryption but should recognize format
      await expect(decrypt(fakeLegacy)).rejects.toThrow()
    })

    it('throws error for invalid format (not enough parts)', async () => {
      await expect(decrypt('invalid')).rejects.toThrow('Invalid encrypted text format')
      await expect(decrypt('one:two')).rejects.toThrow('Invalid encrypted text format')
    })

    it('throws error for invalid format (too many parts)', async () => {
      await expect(decrypt('one:two:three:four:five')).rejects.toThrow('Invalid encrypted text format')
    })

    it('throws error for empty string', async () => {
      await expect(decrypt('')).rejects.toThrow('Encrypted text must be a non-empty string')
    })

    it('throws error for non-string input', async () => {
      await expect(decrypt(null as any)).rejects.toThrow('Encrypted text must be a non-empty string')
      await expect(decrypt(undefined as any)).rejects.toThrow('Encrypted text must be a non-empty string')
    })

    it('throws error for corrupted ciphertext', async () => {
      const encrypted = await encrypt(testData)
      const parts = encrypted.split(':')

      // Corrupt the ciphertext
      parts[3] = parts[3].substring(0, parts[3].length - 4) + 'XXXX'
      const corrupted = parts.join(':')

      await expect(decrypt(corrupted)).rejects.toThrow('Decryption failed')
    })

    it('throws error for corrupted auth tag', async () => {
      const encrypted = await encrypt(testData)
      const parts = encrypted.split(':')

      // Corrupt the auth tag - flip all bits in the first byte
      const authTagHex = parts[2]
      const corruptedAuthTag = 'FF' + authTagHex.substring(2)
      parts[2] = corruptedAuthTag
      const corrupted = parts.join(':')

      await expect(decrypt(corrupted)).rejects.toThrow('Decryption failed')
    })

    it('throws error for invalid hex encoding', async () => {
      const invalidHex = 'validhex:validhex:ZZZZZZ:validhex'
      await expect(decrypt(invalidHex)).rejects.toThrow()
    })
  })

  describe('encryption security', () => {
    it('different salts produce different ciphertexts for same data', async () => {
      const encrypted1 = await encrypt(testData)
      const encrypted2 = await encrypt(testData)

      const parts1 = encrypted1.split(':')
      const parts2 = encrypted2.split(':')

      // Different salts
      expect(parts1[0]).not.toBe(parts2[0])
      // Different IVs
      expect(parts1[1]).not.toBe(parts2[1])
      // Different ciphertexts
      expect(parts1[3]).not.toBe(parts2[3])
    })

    it('provides authenticated encryption (tamper detection)', async () => {
      const encrypted = await encrypt(testData)
      const parts = encrypted.split(':')

      // Tamper with ciphertext but keep auth tag
      parts[3] = parts[3].substring(0, parts[3].length - 2) + 'FF'
      const tampered = parts.join(':')

      // Should fail authentication
      await expect(decrypt(tampered)).rejects.toThrow()
    })

    it('each encryption uses unique salt (128-bit entropy)', async () => {
      const salts = new Set<string>()

      for (let i = 0; i < 20; i++) {
        const encrypted = await encrypt(testData)
        const salt = encrypted.split(':')[0]
        salts.add(salt)
      }

      // All salts should be unique
      expect(salts.size).toBe(20)
    }, 15000) // Increased timeout for Docker crypto operations

    it('each encryption uses unique IV (128-bit entropy)', async () => {
      const ivs = new Set<string>()

      for (let i = 0; i < 20; i++) {
        const encrypted = await encrypt(testData)
        const iv = encrypted.split(':')[1]
        ivs.add(iv)
      }

      // All IVs should be unique
      expect(ivs.size).toBe(20)
    }, 15000) // Increased timeout for Docker crypto operations
  })

  describe('round-trip encryption', () => {
    const testCases = [
      { name: 'simple text', value: 'hello world' },
      { name: 'API key format', value: 'sk-1234567890abcdef' },
      { name: 'JWT token', value: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U' },
      { name: 'empty-like', value: '   ' },
      { name: 'newlines', value: 'line1\nline2\nline3' },
      { name: 'tabs', value: 'col1\tcol2\tcol3' },
      { name: 'mixed whitespace', value: ' \t\n\r ' },
    ]

    testCases.forEach(({ name, value }) => {
      it(`successfully encrypts and decrypts ${name}`, async () => {
        const encrypted = await encrypt(value)
        const decrypted = await decrypt(encrypted)

        expect(decrypted).toBe(value)
      })
    })
  })

  describe('environment validation', () => {
    it('requires ENCRYPTION_KEY environment variable', async () => {
      const original = process.env.ENCRYPTION_KEY
      delete process.env.ENCRYPTION_KEY

      await expect(encrypt(testData)).rejects.toThrow('ENCRYPTION_KEY environment variable is required')

      process.env.ENCRYPTION_KEY = original
    })

    it('requires ENCRYPTION_KEY to be at least 32 characters', async () => {
      const original = process.env.ENCRYPTION_KEY
      process.env.ENCRYPTION_KEY = 'tooshort'

      await expect(encrypt(testData)).rejects.toThrow('ENCRYPTION_KEY must be at least 32 characters long')

      process.env.ENCRYPTION_KEY = original
    })
  })

  describe('isLegacyFormat', () => {
    it('returns true for legacy 3-part format', () => {
      // Legacy format: iv:authTag:ciphertext
      const legacyFormat = 'aabbccdd:11223344:55667788'
      expect(isLegacyFormat(legacyFormat)).toBe(true)
    })

    it('returns false for current 4-part format', async () => {
      // New format: salt:iv:authTag:ciphertext
      const encrypted = await encrypt(testData)
      expect(isLegacyFormat(encrypted)).toBe(false)
    })

    it('returns false for current 4-part format (static example)', () => {
      const currentFormat = 'salt:iv:authTag:ciphertext'
      expect(isLegacyFormat(currentFormat)).toBe(false)
    })

    it('returns false for invalid formats with wrong part count', () => {
      expect(isLegacyFormat('one')).toBe(false)
      expect(isLegacyFormat('one:two')).toBe(false)
      expect(isLegacyFormat('one:two:three:four:five')).toBe(false)
      expect(isLegacyFormat('a:b:c:d:e:f')).toBe(false)
    })

    it('returns false for empty string', () => {
      expect(isLegacyFormat('')).toBe(false)
    })

    it('returns false for null/undefined', () => {
      expect(isLegacyFormat(null as any)).toBe(false)
      expect(isLegacyFormat(undefined as any)).toBe(false)
    })

    it('returns false for non-string types', () => {
      expect(isLegacyFormat(123 as any)).toBe(false)
      expect(isLegacyFormat({} as any)).toBe(false)
      expect(isLegacyFormat([] as any)).toBe(false)
    })

    it('correctly detects format based on colon count only', () => {
      // Doesn't validate hex content, just structure
      expect(isLegacyFormat('any:thing:here')).toBe(true)
      expect(isLegacyFormat('any:thing:here:now')).toBe(false)
    })

    it('handles edge case with empty parts', () => {
      // Three colons means 4 parts (some empty)
      expect(isLegacyFormat(':::')).toBe(false) // 4 empty parts
      // Two colons means 3 parts
      expect(isLegacyFormat('::')).toBe(true) // 3 empty parts
    })
  })

  describe('reEncrypt', () => {
    const testData = 'sensitive-api-key-12345'

    describe('current format (no migration needed)', () => {
      it('returns migrated=false for current 4-part format', async () => {
        const encrypted = await encrypt(testData)
        const result = await reEncrypt(encrypted)

        expect(result.migrated).toBe(false)
        expect(result.encryptedText).toBe(encrypted) // Returns original unchanged
      })

      it('returns the exact same ciphertext for current format', async () => {
        const encrypted = await encrypt(testData)
        const result = await reEncrypt(encrypted)

        // Should be byte-for-byte identical
        expect(result.encryptedText).toBe(encrypted)
      })

      it('works correctly for various data types in current format', async () => {
        const testCases = [
          'simple-text',
          'with spaces and special chars !@#$%',
          '你好世界 🌍',
          'a'.repeat(5000), // large data
        ]

        for (const data of testCases) {
          const encrypted = await encrypt(data)
          const result = await reEncrypt(encrypted)

          expect(result.migrated).toBe(false)
          expect(result.encryptedText).toBe(encrypted)
        }
      })
    })

    describe('legacy format (migration needed)', () => {
      it('returns migrated=true for legacy 3-part format', async () => {
        const legacyEncrypted = await createLegacyEncrypted(testData)
        const result = await reEncrypt(legacyEncrypted)

        expect(result.migrated).toBe(true)
        expect(result.encryptedText).not.toBe(legacyEncrypted)
      })

      it('produces 4-part format after migration', async () => {
        const legacyEncrypted = await createLegacyEncrypted(testData)
        const result = await reEncrypt(legacyEncrypted)

        const parts = result.encryptedText.split(':')
        expect(parts.length).toBe(4)
      })

      it('migrated ciphertext is no longer detected as legacy', async () => {
        const legacyEncrypted = await createLegacyEncrypted(testData)
        const result = await reEncrypt(legacyEncrypted)

        expect(isLegacyFormat(result.encryptedText)).toBe(false)
      })

      it('preserves original plaintext through migration', async () => {
        const legacyEncrypted = await createLegacyEncrypted(testData)
        const result = await reEncrypt(legacyEncrypted)

        // Decrypt the migrated ciphertext
        const decrypted = await decrypt(result.encryptedText)
        expect(decrypted).toBe(testData)
      })

      it('works correctly for various data types', async () => {
        const testCases = [
          'simple-text',
          'with spaces and special chars !@#$%',
          '你好世界 🌍',
          'line1\nline2\tline3',
        ]

        for (const data of testCases) {
          const legacyEncrypted = await createLegacyEncrypted(data)
          const result = await reEncrypt(legacyEncrypted)

          expect(result.migrated).toBe(true)
          const decrypted = await decrypt(result.encryptedText)
          expect(decrypted).toBe(data)
        }
      })

      it('produces unique ciphertext on each migration of same data', async () => {
        // Each migration should use new salt/IV
        const legacyEncrypted1 = await createLegacyEncrypted(testData)
        const legacyEncrypted2 = await createLegacyEncrypted(testData)

        const result1 = await reEncrypt(legacyEncrypted1)
        const result2 = await reEncrypt(legacyEncrypted2)

        expect(result1.encryptedText).not.toBe(result2.encryptedText)
      })
    })

    describe('error handling', () => {
      it('throws error for empty string', async () => {
        await expect(reEncrypt('')).rejects.toThrow('Encrypted text must be a non-empty string')
      })

      it('throws error for null/undefined', async () => {
        await expect(reEncrypt(null as any)).rejects.toThrow('Encrypted text must be a non-empty string')
        await expect(reEncrypt(undefined as any)).rejects.toThrow('Encrypted text must be a non-empty string')
      })

      it('throws error for non-string input', async () => {
        await expect(reEncrypt(123 as any)).rejects.toThrow('Encrypted text must be a non-empty string')
      })

      it('throws error for corrupted legacy data', async () => {
        const legacyEncrypted = await createLegacyEncrypted(testData)
        const parts = legacyEncrypted.split(':')
        // Corrupt the ciphertext
        parts[2] = parts[2].substring(0, parts[2].length - 4) + 'XXXX'
        const corrupted = parts.join(':')

        await expect(reEncrypt(corrupted)).rejects.toThrow()
      })

      it('throws error for corrupted current format data', async () => {
        const encrypted = await encrypt(testData)
        const parts = encrypted.split(':')
        // Corrupt the ciphertext
        parts[3] = parts[3].substring(0, parts[3].length - 4) + 'XXXX'
        const corrupted = parts.join(':')

        // This should fail during the isLegacyFormat check (returns false for 4-part),
        // so it tries decryptNew which should fail
        await expect(reEncrypt(corrupted)).rejects.toThrow()
      })

      it('throws for invalid format (wrong part count)', async () => {
        // 2 parts - invalid
        await expect(reEncrypt('one:two')).rejects.toThrow()
        // 5 parts - invalid
        await expect(reEncrypt('one:two:three:four:five')).rejects.toThrow()
      })
    })

    describe('idempotency', () => {
      it('calling reEncrypt on already-migrated data returns unchanged', async () => {
        const legacyEncrypted = await createLegacyEncrypted(testData)

        // First migration
        const result1 = await reEncrypt(legacyEncrypted)
        expect(result1.migrated).toBe(true)

        // Second call on migrated data
        const result2 = await reEncrypt(result1.encryptedText)
        expect(result2.migrated).toBe(false)
        expect(result2.encryptedText).toBe(result1.encryptedText)
      })

      it('multiple calls on current format return same result', async () => {
        const encrypted = await encrypt(testData)

        const result1 = await reEncrypt(encrypted)
        const result2 = await reEncrypt(result1.encryptedText)
        const result3 = await reEncrypt(result2.encryptedText)

        expect(result1.migrated).toBe(false)
        expect(result2.migrated).toBe(false)
        expect(result3.migrated).toBe(false)
        expect(result1.encryptedText).toBe(encrypted)
        expect(result2.encryptedText).toBe(encrypted)
        expect(result3.encryptedText).toBe(encrypted)
      })
    })
  })

  describe('decryptAndMigrate', () => {
    const testData = 'sensitive-api-key-12345'

    describe('current format (no migration)', () => {
      it('returns decrypted plaintext for current format', async () => {
        const encrypted = await encrypt(testData)
        const updateCallback = vi.fn()

        const result = await decryptAndMigrate(encrypted, updateCallback)

        expect(result).toBe(testData)
      })

      it('does not call updateCallback for current format', async () => {
        const encrypted = await encrypt(testData)
        const updateCallback = vi.fn()

        await decryptAndMigrate(encrypted, updateCallback)

        expect(updateCallback).not.toHaveBeenCalled()
      })

      it('works correctly for various data types', async () => {
        const testCases = [
          'simple-text',
          'with spaces and special chars !@#$%',
          '你好世界 🌍',
          'a'.repeat(5000), // large data
        ]

        for (const data of testCases) {
          const encrypted = await encrypt(data)
          const updateCallback = vi.fn()

          const result = await decryptAndMigrate(encrypted, updateCallback)

          expect(result).toBe(data)
          expect(updateCallback).not.toHaveBeenCalled()
        }
      })
    })

    describe('legacy format (migration triggered)', () => {
      it('returns decrypted plaintext for legacy format', async () => {
        const legacyEncrypted = await createLegacyEncrypted(testData)
        const updateCallback = vi.fn()

        const result = await decryptAndMigrate(legacyEncrypted, updateCallback)

        expect(result).toBe(testData)
      })

      it('calls updateCallback with new 4-part format ciphertext', async () => {
        const legacyEncrypted = await createLegacyEncrypted(testData)
        const updateCallback = vi.fn()

        await decryptAndMigrate(legacyEncrypted, updateCallback)

        expect(updateCallback).toHaveBeenCalledTimes(1)

        // Verify the new ciphertext is 4-part format
        const newEncryptedText = updateCallback.mock.calls[0][0]
        const parts = newEncryptedText.split(':')
        expect(parts.length).toBe(4)
      })

      it('new ciphertext from callback decrypts to original plaintext', async () => {
        const legacyEncrypted = await createLegacyEncrypted(testData)
        let capturedNewCiphertext = ''
        const updateCallback = vi.fn(async (newEncryptedText: string) => {
          capturedNewCiphertext = newEncryptedText
        })

        await decryptAndMigrate(legacyEncrypted, updateCallback)

        // Decrypt the new ciphertext to verify it matches original
        const decrypted = await decrypt(capturedNewCiphertext)
        expect(decrypted).toBe(testData)
      })

      it('new ciphertext is no longer detected as legacy', async () => {
        const legacyEncrypted = await createLegacyEncrypted(testData)
        let capturedNewCiphertext = ''
        const updateCallback = vi.fn(async (newEncryptedText: string) => {
          capturedNewCiphertext = newEncryptedText
        })

        await decryptAndMigrate(legacyEncrypted, updateCallback)

        expect(isLegacyFormat(capturedNewCiphertext)).toBe(false)
      })

      it('works correctly for various legacy data types', async () => {
        const testCases = [
          'simple-text',
          'with spaces and special chars !@#$%',
          '你好世界 🌍',
          'line1\nline2\tline3',
        ]

        for (const data of testCases) {
          const legacyEncrypted = await createLegacyEncrypted(data)
          let capturedNewCiphertext = ''
          const updateCallback = vi.fn(async (newEncryptedText: string) => {
            capturedNewCiphertext = newEncryptedText
          })

          const result = await decryptAndMigrate(legacyEncrypted, updateCallback)

          expect(result).toBe(data)
          expect(updateCallback).toHaveBeenCalledTimes(1)

          // Verify migrated ciphertext decrypts correctly
          const decrypted = await decrypt(capturedNewCiphertext)
          expect(decrypted).toBe(data)
        }
      })
    })

    describe('callback error handling', () => {
      it('returns plaintext even when callback throws', async () => {
        const legacyEncrypted = await createLegacyEncrypted(testData)
        const updateCallback = vi.fn().mockRejectedValue(new Error('Database connection failed'))

        const result = await decryptAndMigrate(legacyEncrypted, updateCallback)

        // Should still return the plaintext despite callback error
        expect(result).toBe(testData)
      })

      it('callback is still called when it will throw', async () => {
        const legacyEncrypted = await createLegacyEncrypted(testData)
        const updateCallback = vi.fn().mockRejectedValue(new Error('Network error'))

        await decryptAndMigrate(legacyEncrypted, updateCallback)

        expect(updateCallback).toHaveBeenCalledTimes(1)
      })

      it('handles synchronous callback errors gracefully', async () => {
        const legacyEncrypted = await createLegacyEncrypted(testData)
        const updateCallback = vi.fn(() => {
          throw new Error('Sync error')
        })

        const result = await decryptAndMigrate(legacyEncrypted, updateCallback)

        expect(result).toBe(testData)
      })

      it('does not retry callback on failure', async () => {
        const legacyEncrypted = await createLegacyEncrypted(testData)
        const updateCallback = vi.fn().mockRejectedValue(new Error('First failure'))

        await decryptAndMigrate(legacyEncrypted, updateCallback)

        // Should only be called once (no retries)
        expect(updateCallback).toHaveBeenCalledTimes(1)
      })
    })

    describe('input validation', () => {
      it('throws error for empty string', async () => {
        const updateCallback = vi.fn()

        await expect(decryptAndMigrate('', updateCallback))
          .rejects.toThrow('Encrypted text must be a non-empty string')
      })

      it('throws error for null/undefined encryptedText', async () => {
        const updateCallback = vi.fn()

        await expect(decryptAndMigrate(null as any, updateCallback))
          .rejects.toThrow('Encrypted text must be a non-empty string')
        await expect(decryptAndMigrate(undefined as any, updateCallback))
          .rejects.toThrow('Encrypted text must be a non-empty string')
      })

      it('throws error for non-string input', async () => {
        const updateCallback = vi.fn()

        await expect(decryptAndMigrate(123 as any, updateCallback))
          .rejects.toThrow('Encrypted text must be a non-empty string')
      })

      it('throws error for missing callback', async () => {
        const encrypted = await encrypt(testData)

        await expect(decryptAndMigrate(encrypted, null as any))
          .rejects.toThrow('updateCallback must be a function')
        await expect(decryptAndMigrate(encrypted, undefined as any))
          .rejects.toThrow('updateCallback must be a function')
      })

      it('throws error for non-function callback', async () => {
        const encrypted = await encrypt(testData)

        await expect(decryptAndMigrate(encrypted, 'not-a-function' as any))
          .rejects.toThrow('updateCallback must be a function')
        await expect(decryptAndMigrate(encrypted, {} as any))
          .rejects.toThrow('updateCallback must be a function')
      })

      it('throws error for corrupted ciphertext (current format)', async () => {
        const encrypted = await encrypt(testData)
        const parts = encrypted.split(':')
        parts[3] = parts[3].substring(0, parts[3].length - 4) + 'XXXX'
        const corrupted = parts.join(':')
        const updateCallback = vi.fn()

        await expect(decryptAndMigrate(corrupted, updateCallback))
          .rejects.toThrow('Decryption failed')
      })

      it('throws error for corrupted ciphertext (legacy format)', async () => {
        const legacyEncrypted = await createLegacyEncrypted(testData)
        const parts = legacyEncrypted.split(':')
        parts[2] = parts[2].substring(0, parts[2].length - 4) + 'XXXX'
        const corrupted = parts.join(':')
        const updateCallback = vi.fn()

        await expect(decryptAndMigrate(corrupted, updateCallback))
          .rejects.toThrow()
      })

      it('throws error for invalid format (wrong part count)', async () => {
        const updateCallback = vi.fn()

        await expect(decryptAndMigrate('one:two', updateCallback))
          .rejects.toThrow('Invalid encrypted text format')
        await expect(decryptAndMigrate('one:two:three:four:five', updateCallback))
          .rejects.toThrow('Invalid encrypted text format')
      })
    })

    describe('idempotency', () => {
      it('only triggers migration once for legacy data', async () => {
        const legacyEncrypted = await createLegacyEncrypted(testData)
        let migratedCiphertext = ''
        const firstCallback = vi.fn(async (newEncryptedText: string) => {
          migratedCiphertext = newEncryptedText
        })

        // First call - should migrate
        await decryptAndMigrate(legacyEncrypted, firstCallback)
        expect(firstCallback).toHaveBeenCalledTimes(1)

        // Second call with migrated ciphertext - should not trigger callback
        const secondCallback = vi.fn()
        await decryptAndMigrate(migratedCiphertext, secondCallback)
        expect(secondCallback).not.toHaveBeenCalled()
      })

      it('repeated calls with current format never trigger callback', async () => {
        const encrypted = await encrypt(testData)
        const callback = vi.fn()

        await decryptAndMigrate(encrypted, callback)
        await decryptAndMigrate(encrypted, callback)
        await decryptAndMigrate(encrypted, callback)

        expect(callback).not.toHaveBeenCalled()
      })
    })
  })

  /**
   * Integration tests that verify the complete legacy format migration flow.
   * These tests simulate real-world scenarios where:
   * 1. Legacy encrypted data exists (from older app versions)
   * 2. Data is accessed and automatically migrated
   * 3. The migrated data is persisted and used going forward
   */
  describe('Integration: Legacy Format Migration Flow', () => {
    const originalPlaintext = 'sk-real-api-key-1234567890abcdef'

    describe('end-to-end migration flow', () => {
      it('complete flow: create legacy → detect → decrypt → migrate → persist → verify', async () => {
        // Step 1: Create legacy-format encrypted data (simulating old data in database)
        const legacyEncrypted = await createLegacyEncrypted(originalPlaintext)

        // Step 2: Verify it's detected as legacy format
        expect(isLegacyFormat(legacyEncrypted)).toBe(true)
        expect(legacyEncrypted.split(':').length).toBe(3)

        // Step 3: Verify legacy data can be decrypted
        const decryptedFromLegacy = await decrypt(legacyEncrypted)
        expect(decryptedFromLegacy).toBe(originalPlaintext)

        // Step 4: Migrate using reEncrypt
        const migrationResult = await reEncrypt(legacyEncrypted)
        expect(migrationResult.migrated).toBe(true)

        // Step 5: Verify migrated format is correct (4-part)
        expect(isLegacyFormat(migrationResult.encryptedText)).toBe(false)
        expect(migrationResult.encryptedText.split(':').length).toBe(4)

        // Step 6: Verify migrated data can be decrypted
        const decryptedFromMigrated = await decrypt(migrationResult.encryptedText)
        expect(decryptedFromMigrated).toBe(originalPlaintext)

        // Step 7: Verify original plaintext is preserved through entire flow
        expect(decryptedFromLegacy).toBe(decryptedFromMigrated)
      })

      it('simulates database persistence flow with decryptAndMigrate', async () => {
        // Simulate a database row with legacy encrypted data
        const simulatedDbRow = {
          userId: 'user-123',
          encryptedApiKey: await createLegacyEncrypted(originalPlaintext)
        }

        // Verify initial state is legacy
        expect(isLegacyFormat(simulatedDbRow.encryptedApiKey)).toBe(true)

        // Simulate the auto-migration callback that would update the database
        const updateCallback = vi.fn(async (newEncryptedText: string) => {
          // This simulates: UPDATE user_ai_settings SET encryptedApiKey = newEncryptedText WHERE userId = 'user-123'
          simulatedDbRow.encryptedApiKey = newEncryptedText
        })

        // Access the data (triggers migration)
        const plaintext = await decryptAndMigrate(simulatedDbRow.encryptedApiKey, updateCallback)

        // Verify the plaintext was returned correctly
        expect(plaintext).toBe(originalPlaintext)

        // Verify the callback was called (database update would happen)
        expect(updateCallback).toHaveBeenCalledTimes(1)

        // Verify the simulated database now has current format
        expect(isLegacyFormat(simulatedDbRow.encryptedApiKey)).toBe(false)
        expect(simulatedDbRow.encryptedApiKey.split(':').length).toBe(4)

        // Verify subsequent accesses don't trigger migration
        const subsequentCallback = vi.fn()
        const plaintextAgain = await decryptAndMigrate(simulatedDbRow.encryptedApiKey, subsequentCallback)

        expect(plaintextAgain).toBe(originalPlaintext)
        expect(subsequentCallback).not.toHaveBeenCalled()
      })

      it('multiple legacy entries can be migrated independently', async () => {
        const entries = [
          { id: 1, plaintext: 'api-key-user-1', encrypted: '' },
          { id: 2, plaintext: 'api-key-user-2', encrypted: '' },
          { id: 3, plaintext: 'api-key-user-3', encrypted: '' }
        ]

        // Create legacy encrypted data for each entry
        for (const entry of entries) {
          entry.encrypted = await createLegacyEncrypted(entry.plaintext)
        }

        // Verify all are legacy format
        for (const entry of entries) {
          expect(isLegacyFormat(entry.encrypted)).toBe(true)
        }

        // Migrate each entry
        const migratedEntries = await Promise.all(
          entries.map(async (entry) => {
            const result = await reEncrypt(entry.encrypted)
            return {
              ...entry,
              encrypted: result.encryptedText,
              wasMigrated: result.migrated
            }
          })
        )

        // Verify all were migrated
        for (const entry of migratedEntries) {
          expect(entry.wasMigrated).toBe(true)
          expect(isLegacyFormat(entry.encrypted)).toBe(false)

          // Verify plaintext preserved
          const decrypted = await decrypt(entry.encrypted)
          expect(decrypted).toBe(entry.plaintext)
        }

        // Verify each has unique salt (all different from each other)
        const salts = migratedEntries.map((e) => e.encrypted.split(':')[0])
        const uniqueSalts = new Set(salts)
        expect(uniqueSalts.size).toBe(entries.length)
      })
    })

    describe('data integrity through migration', () => {
      const dataIntegrityTestCases = [
        { name: 'OpenAI API key', value: 'sk-proj-aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890' },
        { name: 'Anthropic API key', value: 'sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890-abcdef' },
        { name: 'Google API key', value: 'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ12345' },
        { name: 'special characters', value: 'key-with-special!@#$%^&*()_+-=[]{}|;:\'",.<>?/chars' },
        { name: 'unicode content', value: '密钥-🔐-مفتاح-κλειδί-🗝️' },
        { name: 'multiline content', value: 'line1\nline2\r\nline3\ttabbed' },
        { name: 'very long content', value: 'x'.repeat(1000) }
      ]

      dataIntegrityTestCases.forEach(({ name, value }) => {
        it(`preserves ${name} through complete migration flow`, async () => {
          // Create legacy format
          const legacyEncrypted = await createLegacyEncrypted(value)

          // Verify can decrypt from legacy
          const decryptedLegacy = await decrypt(legacyEncrypted)
          expect(decryptedLegacy).toBe(value)

          // Migrate to current format
          const { migrated, encryptedText: migratedEncrypted } = await reEncrypt(legacyEncrypted)
          expect(migrated).toBe(true)

          // Verify can decrypt from migrated
          const decryptedMigrated = await decrypt(migratedEncrypted)
          expect(decryptedMigrated).toBe(value)

          // Verify byte-for-byte equality
          expect(decryptedLegacy).toBe(decryptedMigrated)
        })
      })
    })

    describe('format verification', () => {
      it('legacy format has 3 colon-separated hex parts', async () => {
        const legacyEncrypted = await createLegacyEncrypted(originalPlaintext)
        const parts = legacyEncrypted.split(':')

        expect(parts.length).toBe(3)

        // Verify each part is valid hex
        parts.forEach((part) => {
          expect(part).toMatch(/^[0-9a-f]+$/i)
        })

        // Verify expected lengths (IV=16 bytes=32 hex, authTag=16 bytes=32 hex)
        expect(parts[0].length).toBe(32) // IV
        expect(parts[1].length).toBe(32) // authTag
        expect(parts[2].length).toBeGreaterThan(0) // ciphertext
      })

      it('current format has 4 colon-separated hex parts with unique salt', async () => {
        const legacyEncrypted = await createLegacyEncrypted(originalPlaintext)
        const { encryptedText: migratedEncrypted } = await reEncrypt(legacyEncrypted)
        const parts = migratedEncrypted.split(':')

        expect(parts.length).toBe(4)

        // Verify each part is valid hex
        parts.forEach((part) => {
          expect(part).toMatch(/^[0-9a-f]+$/i)
        })

        // Verify expected lengths (salt=32 bytes=64 hex, IV=16 bytes=32 hex, authTag=16 bytes=32 hex)
        expect(parts[0].length).toBe(64) // salt
        expect(parts[1].length).toBe(32) // IV
        expect(parts[2].length).toBe(32) // authTag
        expect(parts[3].length).toBeGreaterThan(0) // ciphertext
      })

      it('each migration produces unique salt and IV', async () => {
        const legacyEncrypted = await createLegacyEncrypted(originalPlaintext)

        // Migrate same legacy data multiple times (simulating if migration failed and retried)
        const results = await Promise.all([
          reEncrypt(legacyEncrypted),
          reEncrypt(legacyEncrypted),
          reEncrypt(legacyEncrypted)
        ])

        // All should be migrated
        results.forEach((r) => expect(r.migrated).toBe(true))

        // All should have different salts
        const salts = results.map((r) => r.encryptedText.split(':')[0])
        const uniqueSalts = new Set(salts)
        expect(uniqueSalts.size).toBe(3)

        // All should have different IVs
        const ivs = results.map((r) => r.encryptedText.split(':')[1])
        const uniqueIvs = new Set(ivs)
        expect(uniqueIvs.size).toBe(3)

        // But all should decrypt to same plaintext
        for (const result of results) {
          const decrypted = await decrypt(result.encryptedText)
          expect(decrypted).toBe(originalPlaintext)
        }
      })
    })

    describe('migration idempotency and safety', () => {
      it('reEncrypt is idempotent - running twice returns same for current format', async () => {
        const legacyEncrypted = await createLegacyEncrypted(originalPlaintext)

        // First migration
        const firstResult = await reEncrypt(legacyEncrypted)
        expect(firstResult.migrated).toBe(true)

        // Second run on already-migrated data
        const secondResult = await reEncrypt(firstResult.encryptedText)
        expect(secondResult.migrated).toBe(false)
        expect(secondResult.encryptedText).toBe(firstResult.encryptedText)

        // Third run
        const thirdResult = await reEncrypt(secondResult.encryptedText)
        expect(thirdResult.migrated).toBe(false)
        expect(thirdResult.encryptedText).toBe(firstResult.encryptedText)
      })

      it('decryptAndMigrate only triggers callback once per legacy entry', async () => {
        const legacyEncrypted = await createLegacyEncrypted(originalPlaintext)
        let persistedCiphertext = legacyEncrypted

        // First access - should migrate
        const firstCallback = vi.fn(async (newCiphertext: string) => {
          persistedCiphertext = newCiphertext
        })
        const firstPlaintext = await decryptAndMigrate(persistedCiphertext, firstCallback)
        expect(firstPlaintext).toBe(originalPlaintext)
        expect(firstCallback).toHaveBeenCalledTimes(1)

        // Second access with now-migrated data - should not trigger callback
        const secondCallback = vi.fn()
        const secondPlaintext = await decryptAndMigrate(persistedCiphertext, secondCallback)
        expect(secondPlaintext).toBe(originalPlaintext)
        expect(secondCallback).not.toHaveBeenCalled()

        // Third access - still no callback
        const thirdCallback = vi.fn()
        const thirdPlaintext = await decryptAndMigrate(persistedCiphertext, thirdCallback)
        expect(thirdPlaintext).toBe(originalPlaintext)
        expect(thirdCallback).not.toHaveBeenCalled()
      })

      it('failed migration callback does not corrupt data access', async () => {
        const legacyEncrypted = await createLegacyEncrypted(originalPlaintext)

        // Callback that fails (simulating database error)
        const failingCallback = vi.fn().mockRejectedValue(new Error('Database connection lost'))

        // Should still return plaintext despite callback failure
        const plaintext = await decryptAndMigrate(legacyEncrypted, failingCallback)
        expect(plaintext).toBe(originalPlaintext)
        expect(failingCallback).toHaveBeenCalled()

        // Original legacy data can still be decrypted
        const directDecrypt = await decrypt(legacyEncrypted)
        expect(directDecrypt).toBe(originalPlaintext)
      })
    })

    describe('mixed format scenarios', () => {
      it('can process batch of mixed legacy and current format entries', async () => {
        // Simulate a database table with mixed formats (some old, some new)
        const entries = [
          { userId: 'user-1', encryptedKey: await createLegacyEncrypted('key-1') },
          { userId: 'user-2', encryptedKey: await encrypt('key-2') }, // Already current format
          { userId: 'user-3', encryptedKey: await createLegacyEncrypted('key-3') },
          { userId: 'user-4', encryptedKey: await encrypt('key-4') }, // Already current format
        ]

        // Process all entries with reEncrypt
        const results = await Promise.all(
          entries.map(async (entry) => {
            const result = await reEncrypt(entry.encryptedKey)
            return {
              userId: entry.userId,
              ...result
            }
          })
        )

        // Verify correct migration status
        expect(results[0].migrated).toBe(true) // user-1 was legacy
        expect(results[1].migrated).toBe(false) // user-2 was already current
        expect(results[2].migrated).toBe(true) // user-3 was legacy
        expect(results[3].migrated).toBe(false) // user-4 was already current

        // Verify all are now current format
        for (const result of results) {
          expect(isLegacyFormat(result.encryptedText)).toBe(false)
        }

        // Verify all can be decrypted to original values
        const decrypted = await Promise.all(
          results.map((r) => decrypt(r.encryptedText))
        )
        expect(decrypted).toEqual(['key-1', 'key-2', 'key-3', 'key-4'])
      })

      it('concurrent migrations do not interfere with each other', async () => {
        const legacyEntries = await Promise.all([
          createLegacyEncrypted('concurrent-key-1'),
          createLegacyEncrypted('concurrent-key-2'),
          createLegacyEncrypted('concurrent-key-3'),
          createLegacyEncrypted('concurrent-key-4'),
          createLegacyEncrypted('concurrent-key-5')
        ])

        // Migrate all concurrently
        const results = await Promise.all(
          legacyEntries.map((entry) => reEncrypt(entry))
        )

        // All should be migrated
        results.forEach((r) => expect(r.migrated).toBe(true))

        // All should decrypt to correct values
        const decryptedValues = await Promise.all(
          results.map((r) => decrypt(r.encryptedText))
        )
        expect(decryptedValues).toEqual([
          'concurrent-key-1',
          'concurrent-key-2',
          'concurrent-key-3',
          'concurrent-key-4',
          'concurrent-key-5'
        ])
      })
    })
  })
})
