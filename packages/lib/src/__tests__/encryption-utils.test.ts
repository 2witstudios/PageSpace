import { describe, it, expect } from 'vitest'
import { scrypt, randomBytes, createCipheriv } from 'crypto'
import { promisify } from 'util'
import { encrypt, decrypt, __resetMasterKeyCacheForTests } from '../encryption/encryption-utils'

const scryptAsync = promisify(scrypt)

/**
 * Builds a legacy-format ciphertext (`salt:iv:authTag:ciphertext`, unique
 * scrypt-derived key per record) the same way `encrypt()` used to, before the
 * memoized-master-key format change. Only used to prove `decrypt()` still
 * reads old rows — new code never produces this format.
 */
async function legacyEncrypt(masterKey: string, text: string): Promise<string> {
  const salt = randomBytes(32)
  const iv = randomBytes(16)
  const key = (await scryptAsync(masterKey, salt, 32)) as Buffer
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${salt.toString('hex')}:${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`
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

    it('produces 3-part colon-separated format (no per-record salt)', async () => {
      const encrypted = await encrypt(testData)
      const parts = encrypted.split(':')

      expect(parts.length).toBe(3)
      expect(parts[0]).toBeTruthy() // iv
      expect(parts[1]).toBeTruthy() // authTag
      expect(parts[2]).toBeTruthy() // ciphertext
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
    it('decrypts encrypted data successfully', async () => {
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

    it('throws error for invalid format (not enough parts)', async () => {
      await expect(decrypt('invalid')).rejects.toThrow('Invalid encrypted text format')
      await expect(decrypt('one:two')).rejects.toThrow('Invalid encrypted text format')
    })

    it('throws error for invalid format (too many parts)', async () => {
      await expect(decrypt('one:two:three:four:five')).rejects.toThrow('Invalid encrypted text format')
    })

    it('a well-formed-count but non-hex 3-part value fails decryption (not format validation)', async () => {
      // 3 parts is a recognized shape (iv:authTag:ciphertext), so this fails
      // during actual decryption, not the up-front format check.
      await expect(decrypt('one:two:three')).rejects.toThrow('Decryption failed')
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

      // Corrupt the ciphertext (index 2 in the iv:authTag:ciphertext format)
      parts[2] = parts[2].substring(0, parts[2].length - 4) + 'XXXX'
      const corrupted = parts.join(':')

      await expect(decrypt(corrupted)).rejects.toThrow('Decryption failed')
    })

    it('throws error for corrupted auth tag', async () => {
      const encrypted = await encrypt(testData)
      const parts = encrypted.split(':')

      // Corrupt the auth tag (index 1) - invert all bytes to guarantee different value
      const authTagHex = parts[1]
      const corruptedAuthTag = authTagHex
        .split('')
        .map((c) => {
          const val = parseInt(c, 16)
          return (15 - val).toString(16) // Invert each hex digit
        })
        .join('')
      parts[1] = corruptedAuthTag
      const corrupted = parts.join(':')

      await expect(decrypt(corrupted)).rejects.toThrow('Decryption failed')
    })

    it('throws error for invalid hex encoding (legacy 4-part shape)', async () => {
      const invalidHex = 'validhex:validhex:ZZZZZZ:validhex'
      await expect(decrypt(invalidHex)).rejects.toThrow()
    })
  })

  describe('encryption security', () => {
    it('different IVs produce different ciphertexts for same data', async () => {
      const encrypted1 = await encrypt(testData)
      const encrypted2 = await encrypt(testData)

      const parts1 = encrypted1.split(':')
      const parts2 = encrypted2.split(':')

      // Different IVs
      expect(parts1[0]).not.toBe(parts2[0])
      // Different ciphertexts
      expect(parts1[2]).not.toBe(parts2[2])
    })

    it('provides authenticated encryption (tamper detection)', async () => {
      const encrypted = await encrypt(testData)
      const parts = encrypted.split(':')

      // Tamper with ciphertext but keep auth tag.
      // XOR the last byte with 0xFF to guarantee the byte changes regardless
      // of its original value (avoids the ~0.4% flake where the last byte was
      // already 0xFF and replacing with 'FF' is a no-op).
      const lastByte = parseInt(parts[2].slice(-2), 16);
      const flipped = (lastByte ^ 0xff).toString(16).padStart(2, '0');
      parts[2] = parts[2].slice(0, -2) + flipped;
      const tampered = parts.join(':')

      // Should fail authentication
      await expect(decrypt(tampered)).rejects.toThrow()
    })

    it('each encryption uses unique IV (128-bit entropy)', async () => {
      const ivs = new Set<string>()

      for (let i = 0; i < 20; i++) {
        const encrypted = await encrypt(testData)
        const iv = encrypted.split(':')[0]
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
      // The master key is memoized after the first successful derivation
      // (from earlier tests in this file), so force a fresh derivation to
      // actually exercise the missing-key path.
      __resetMasterKeyCacheForTests()

      await expect(encrypt(testData)).rejects.toThrow('ENCRYPTION_KEY environment variable is required')

      process.env.ENCRYPTION_KEY = original
    })

    it('requires ENCRYPTION_KEY to be at least 32 characters', async () => {
      const original = process.env.ENCRYPTION_KEY
      process.env.ENCRYPTION_KEY = 'tooshort'
      __resetMasterKeyCacheForTests()

      await expect(encrypt(testData)).rejects.toThrow('ENCRYPTION_KEY must be at least 32 characters long')

      process.env.ENCRYPTION_KEY = original
    })
  })

  describe('format verification', () => {
    it('encrypted format has 3 colon-separated hex parts (iv:authTag:ciphertext)', async () => {
      const encrypted = await encrypt('test-plaintext')
      const parts = encrypted.split(':')

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
  })

  describe('legacy format backward compatibility', () => {
    const MASTER_KEY = 'test-encryption-key-32-chars-minimum-required-length'

    it('decrypts a legacy salt:iv:authTag:ciphertext value produced before this format change', async () => {
      const legacy = await legacyEncrypt(MASTER_KEY, testData)
      expect(legacy.split(':').length).toBe(4)

      const decrypted = await decrypt(legacy)
      expect(decrypted).toBe(testData)
    })

    it('round-trips several legacy values with distinct salts to the correct plaintext each', async () => {
      const values = ['alice@example.com', 'sk-legacy-token-abc', 'unicode 你好 🌍']
      const legacyCiphertexts = await Promise.all(values.map((v) => legacyEncrypt(MASTER_KEY, v)))

      const decrypted = await Promise.all(legacyCiphertexts.map((c) => decrypt(c)))
      expect(decrypted).toEqual(values)
    })
  })

  describe('performance: memoized master key vs per-record scrypt', () => {
    it('decrypting a batch of new-format values is meaningfully faster than the same number of independent scrypt derivations', async () => {
      const BATCH_SIZE = 20
      const plaintexts = Array.from({ length: BATCH_SIZE }, (_, i) => `secret-value-${i}`)
      const ciphertexts = await Promise.all(plaintexts.map((p) => encrypt(p)))

      // Warm the memoized master key so the measurement below isn't dominated
      // by the one-time cold-start derivation.
      await decrypt(ciphertexts[0])

      const fastStart = performance.now()
      await Promise.all(ciphertexts.map((c) => decrypt(c)))
      const fastDuration = performance.now() - fastStart

      // Baseline: what the eliminated legacy per-record scrypt cost looks
      // like — the same number of independent scrypt derivations.
      const baselineStart = performance.now()
      await Promise.all(
        Array.from({ length: BATCH_SIZE }, () => scryptAsync('a-fake-master-key-for-baseline-only!!', randomBytes(32), 32)),
      )
      const baselineDuration = performance.now() - baselineStart

      expect(fastDuration).toBeLessThan(baselineDuration / 2)
    }, 15000)
  })
})
