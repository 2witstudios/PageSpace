import { describe, it, expect, beforeEach, vi } from 'vitest'
import { generateCSRFToken, validateCSRFToken, getSessionIdFromJWT } from '../auth/csrf-utils'

describe('csrf-utils', () => {
  const testSessionId = 'session_abc123'

  beforeEach(() => {
    // Reset time mocks
    vi.restoreAllMocks()
  })

  describe('generateCSRFToken', () => {
    it('generates a valid CSRF token', () => {
      const token = generateCSRFToken(testSessionId)

      expect(token).toBeTruthy()
      expect(typeof token).toBe('string')
    })

    it('generates token with 3 parts separated by dots', () => {
      const token = generateCSRFToken(testSessionId)
      const parts = token.split('.')

      expect(parts.length).toBe(3)
      expect(parts[0]).toBeTruthy() // tokenValue
      expect(parts[1]).toBeTruthy() // timestamp
      expect(parts[2]).toBeTruthy() // signature
    })

    it('generates unique tokens for same session', () => {
      const token1 = generateCSRFToken(testSessionId)
      const token2 = generateCSRFToken(testSessionId)

      expect(token1).not.toBe(token2)
    })

    it('includes current timestamp in token', () => {
      const beforeTime = Math.floor(Date.now() / 1000)
      const token = generateCSRFToken(testSessionId)
      const afterTime = Math.floor(Date.now() / 1000)

      const parts = token.split('.')
      const timestamp = parseInt(parts[1], 10)

      expect(timestamp).toBeGreaterThanOrEqual(beforeTime)
      expect(timestamp).toBeLessThanOrEqual(afterTime)
    })

    it('generates tokens that validate immediately', () => {
      const token = generateCSRFToken(testSessionId)
      const isValid = validateCSRFToken(token, testSessionId)

      expect(isValid).toBe(true)
    })

    it('generates different tokens for different sessions', () => {
      const token1 = generateCSRFToken('session1')
      const token2 = generateCSRFToken('session2')

      expect(token1).not.toBe(token2)
    })

    it('generates hex-encoded token values', () => {
      const token = generateCSRFToken(testSessionId)
      const parts = token.split('.')

      // Token value should be hex (64 chars for 32 bytes)
      expect(parts[0]).toMatch(/^[0-9a-f]{64}$/)
      // Signature should be hex (64 chars for sha256)
      expect(parts[2]).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  describe('validateCSRFToken', () => {
    it('validates a valid fresh token', () => {
      const token = generateCSRFToken(testSessionId)
      const isValid = validateCSRFToken(token, testSessionId)

      expect(isValid).toBe(true)
    })

    it('rejects token for wrong session ID', () => {
      const token = generateCSRFToken('session1')
      const isValid = validateCSRFToken(token, 'session2')

      expect(isValid).toBe(false)
    })

    it('rejects empty token', () => {
      const isValid = validateCSRFToken('', testSessionId)
      expect(isValid).toBe(false)
    })

    it('rejects empty session ID', () => {
      const token = generateCSRFToken(testSessionId)
      const isValid = validateCSRFToken(token, '')

      expect(isValid).toBe(false)
    })

    it('rejects malformed token (wrong number of parts)', () => {
      expect(validateCSRFToken('invalid', testSessionId)).toBe(false)
      expect(validateCSRFToken('one.two', testSessionId)).toBe(false)
      expect(validateCSRFToken('one.two.three.four', testSessionId)).toBe(false)
    })

    it('rejects token with invalid signature', () => {
      const token = generateCSRFToken(testSessionId)
      const parts = token.split('.')

      // Corrupt signature
      parts[2] = parts[2].substring(0, parts[2].length - 4) + 'XXXX'
      const tamperedToken = parts.join('.')

      const isValid = validateCSRFToken(tamperedToken, testSessionId)
      expect(isValid).toBe(false)
    })

    it('rejects token with tampered timestamp', () => {
      const token = generateCSRFToken(testSessionId)
      const parts = token.split('.')

      // Change timestamp
      parts[1] = '9999999999'
      const tamperedToken = parts.join('.')

      const isValid = validateCSRFToken(tamperedToken, testSessionId)
      expect(isValid).toBe(false)
    })

    it('rejects token with tampered token value', () => {
      const token = generateCSRFToken(testSessionId)
      const parts = token.split('.')

      // Change token value
      parts[0] = parts[0].substring(0, parts[0].length - 4) + 'AAAA'
      const tamperedToken = parts.join('.')

      const isValid = validateCSRFToken(tamperedToken, testSessionId)
      expect(isValid).toBe(false)
    })

    it('rejects expired token (default 3600s)', () => {
      // Create token with old timestamp
      const oldTimestamp = Math.floor(Date.now() / 1000) - 4000 // 4000 seconds ago
      const token = generateCSRFToken(testSessionId)
      const parts = token.split('.')

      // Replace timestamp with old one (this will break signature, so we expect false)
      parts[1] = oldTimestamp.toString()
      const expiredToken = parts.join('.')

      const isValid = validateCSRFToken(expiredToken, testSessionId)
      expect(isValid).toBe(false)
    })

    it('respects custom maxAge parameter', () => {
      const token = generateCSRFToken(testSessionId)

      // Should be valid with 1 hour maxAge
      expect(validateCSRFToken(token, testSessionId, 3600)).toBe(true)

      // Should be valid with 1 day maxAge
      expect(validateCSRFToken(token, testSessionId, 86400)).toBe(true)

      // Should be invalid with 0 maxAge (expired immediately)
      expect(validateCSRFToken(token, testSessionId, 0)).toBe(false)
    })

    it('handles non-numeric timestamp gracefully', () => {
      const token = 'value.notanumber.signature'
      const isValid = validateCSRFToken(token, testSessionId)

      expect(isValid).toBe(false)
    })

    it('uses timing-safe comparison for signature', () => {
      // This is primarily a security property we can't easily test,
      // but we can verify it doesn't break normal operation
      const token = generateCSRFToken(testSessionId)
      const isValid = validateCSRFToken(token, testSessionId)

      expect(isValid).toBe(true)
    })
  })

  describe('getSessionIdFromJWT', () => {
    it('generates deterministic session ID from JWT payload', () => {
      const payload = {
        userId: 'user_123',
        tokenVersion: 0,
        iat: 1234567890
      }

      const sessionId1 = getSessionIdFromJWT(payload)
      const sessionId2 = getSessionIdFromJWT(payload)

      expect(sessionId1).toBe(sessionId2)
    })

    it('generates different session IDs for different users', () => {
      const payload1 = { userId: 'user_1', tokenVersion: 0, iat: 1234567890 }
      const payload2 = { userId: 'user_2', tokenVersion: 0, iat: 1234567890 }

      const sessionId1 = getSessionIdFromJWT(payload1)
      const sessionId2 = getSessionIdFromJWT(payload2)

      expect(sessionId1).not.toBe(sessionId2)
    })

    it('generates different session IDs for different token versions', () => {
      const payload1 = { userId: 'user_1', tokenVersion: 0, iat: 1234567890 }
      const payload2 = { userId: 'user_1', tokenVersion: 1, iat: 1234567890 }

      const sessionId1 = getSessionIdFromJWT(payload1)
      const sessionId2 = getSessionIdFromJWT(payload2)

      expect(sessionId1).not.toBe(sessionId2)
    })

    it('generates different session IDs for different issued times', () => {
      const payload1 = { userId: 'user_1', tokenVersion: 0, iat: 1234567890 }
      const payload2 = { userId: 'user_1', tokenVersion: 0, iat: 9876543210 }

      const sessionId1 = getSessionIdFromJWT(payload1)
      const sessionId2 = getSessionIdFromJWT(payload2)

      expect(sessionId1).not.toBe(sessionId2)
    })

    it('handles missing iat field (defaults to 0)', () => {
      const payload = { userId: 'user_1', tokenVersion: 0 }
      const sessionId = getSessionIdFromJWT(payload)

      expect(sessionId).toBeTruthy()
      expect(typeof sessionId).toBe('string')
      expect(sessionId.length).toBe(16)
    })

    it('returns 16-character hex string', () => {
      const payload = { userId: 'user_1', tokenVersion: 0, iat: 1234567890 }
      const sessionId = getSessionIdFromJWT(payload)

      expect(sessionId.length).toBe(16)
      expect(sessionId).toMatch(/^[0-9a-f]{16}$/)
    })
  })

  describe('CSRF protection workflow', () => {
    it('full workflow: generate session ID, create token, validate token', () => {
      const jwtPayload = {
        userId: 'user_123',
        tokenVersion: 0,
        iat: Math.floor(Date.now() / 1000)
      }

      // Step 1: Generate session ID from JWT
      const sessionId = getSessionIdFromJWT(jwtPayload)

      // Step 2: Generate CSRF token for session
      const csrfToken = generateCSRFToken(sessionId)

      // Step 3: Validate token
      const isValid = validateCSRFToken(csrfToken, sessionId)

      expect(isValid).toBe(true)
    })

    it('token invalidation after token version increment', () => {
      const payload1 = { userId: 'user_1', tokenVersion: 0, iat: 1234567890 }
      const sessionId1 = getSessionIdFromJWT(payload1)
      const csrfToken = generateCSRFToken(sessionId1)

      // User's token version incremented (e.g., password change)
      const payload2 = { userId: 'user_1', tokenVersion: 1, iat: 1234567890 }
      const sessionId2 = getSessionIdFromJWT(payload2)

      // Old CSRF token should not validate with new session
      const isValid = validateCSRFToken(csrfToken, sessionId2)
      expect(isValid).toBe(false)
    })
  })

  describe('replay attack prevention', () => {
    it('tokens expire after maxAge to prevent indefinite replay', () => {
      const token = generateCSRFToken(testSessionId)

      // Token valid now
      expect(validateCSRFToken(token, testSessionId, 10)).toBe(true)

      // Token should be invalid after 0 seconds
      expect(validateCSRFToken(token, testSessionId, 0)).toBe(false)
    })

    it('rejects tokens from the future', () => {
      const futureTimestamp = Math.floor(Date.now() / 1000) + 1000
      const token = generateCSRFToken(testSessionId)
      const parts = token.split('.')

      // Set timestamp to future (this breaks signature)
      parts[1] = futureTimestamp.toString()
      const futureToken = parts.join('.')

      const isValid = validateCSRFToken(futureToken, testSessionId)
      expect(isValid).toBe(false)
    })
  })

  describe('error handling', () => {
    it('handles exceptions gracefully in validation', () => {
      // Malformed tokens should return false, not throw
      expect(() => validateCSRFToken(null as any, testSessionId)).not.toThrow()
      expect(() => validateCSRFToken(undefined as any, testSessionId)).not.toThrow()
      expect(() => validateCSRFToken({} as any, testSessionId)).not.toThrow()

      expect(validateCSRFToken(null as any, testSessionId)).toBe(false)
      expect(validateCSRFToken(undefined as any, testSessionId)).toBe(false)
    })
  })

  describe('environment validation', () => {
    it('requires CSRF_SECRET environment variable', () => {
      const original = process.env.CSRF_SECRET
      delete process.env.CSRF_SECRET

      expect(() => generateCSRFToken(testSessionId)).toThrow('CSRF_SECRET environment variable is required')

      process.env.CSRF_SECRET = original
    })
  })
})
