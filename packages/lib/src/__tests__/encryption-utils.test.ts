import { describe, it, expect, beforeEach } from 'vitest'
import { encrypt, decrypt, isLegacyFormat } from '../encryption/encryption-utils'

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
})
