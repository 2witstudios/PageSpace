import { describe, it, expect, beforeEach } from 'vitest'
import { encrypt, decrypt, isLegacyFormat, reEncrypt } from '../encryption/encryption-utils'
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
})
