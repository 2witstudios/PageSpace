import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { generateCSRFToken, validateCSRFToken } from '../auth/csrf-utils'

/**
 * CSRF Token Contract Tests
 *
 * This test suite validates the CSRF token security mechanism which uses:
 * - Synchronizer Token Pattern with HMAC-SHA256 signatures
 * - Session-bound tokens (tied to server-validated session IDs)
 * - Time-limited validity (default 3600s)
 *
 * Token format: tokenValue.timestamp.signature
 * - tokenValue: 32 random bytes (64 hex chars)
 * - timestamp: Unix epoch seconds
 * - signature: HMAC-SHA256(sessionId.tokenValue.timestamp) using CSRF_SECRET
 */
describe('csrf-utils', () => {
  const testSessionId = 'session_abc123'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
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

    it('throws error for empty sessionId', () => {
      expect(() => generateCSRFToken('')).toThrow('Invalid sessionId: must be a non-empty string')
    })

    it('throws error for whitespace-only sessionId', () => {
      expect(() => generateCSRFToken('   ')).toThrow('Invalid sessionId: must be a non-empty string')
      expect(() => generateCSRFToken('\t\n')).toThrow('Invalid sessionId: must be a non-empty string')
    })

    it('throws error for null or undefined sessionId', () => {
      expect(() => generateCSRFToken(null as any)).toThrow('Invalid sessionId: must be a non-empty string')
      expect(() => generateCSRFToken(undefined as any)).toThrow('Invalid sessionId: must be a non-empty string')
    })

    it('throws error for non-string sessionId', () => {
      expect(() => generateCSRFToken(123 as any)).toThrow('Invalid sessionId: must be a non-empty string')
      expect(() => generateCSRFToken({} as any)).toThrow('Invalid sessionId: must be a non-empty string')
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

    it('validateCSRFToken_tokenExceedsDefaultMaxAge_returnsFalse', () => {
      // Arrange: Use fake timers for deterministic expiration testing
      vi.useFakeTimers()
      const startTime = new Date('2024-01-15T12:00:00Z')
      vi.setSystemTime(startTime)

      const token = generateCSRFToken(testSessionId)

      // Act: Advance time past default 3600s (1 hour) maxAge
      vi.advanceTimersByTime(3601 * 1000) // 3601 seconds

      // Assert: Token should be expired
      const isValid = validateCSRFToken(token, testSessionId)
      expect(isValid).toBe(false)
    })

    it('validateCSRFToken_tokenWithinMaxAge_returnsTrue', () => {
      // Arrange: Use fake timers
      vi.useFakeTimers()
      const startTime = new Date('2024-01-15T12:00:00Z')
      vi.setSystemTime(startTime)

      const token = generateCSRFToken(testSessionId)

      // Act: Advance time to just before expiration (3599 seconds)
      vi.advanceTimersByTime(3599 * 1000)

      // Assert: Token should still be valid
      const isValid = validateCSRFToken(token, testSessionId)
      expect(isValid).toBe(true)
    })

    it('validateCSRFToken_withCustomMaxAge_respectsCustomExpiration', () => {
      // Arrange: Use fake timers
      vi.useFakeTimers()
      const startTime = new Date('2024-01-15T12:00:00Z')
      vi.setSystemTime(startTime)

      const token = generateCSRFToken(testSessionId)

      // Act & Assert: Token valid at creation
      expect(validateCSRFToken(token, testSessionId, 60)).toBe(true)

      // Advance 59 seconds - still valid
      vi.advanceTimersByTime(59 * 1000)
      expect(validateCSRFToken(token, testSessionId, 60)).toBe(true)

      // Advance 2 more seconds - now expired (61 seconds total)
      vi.advanceTimersByTime(2 * 1000)
      expect(validateCSRFToken(token, testSessionId, 60)).toBe(false)
    })

    it('validateCSRFToken_withZeroMaxAge_returnsfalseImmediately', () => {
      const token = generateCSRFToken(testSessionId)
      // maxAge=0 means tokens expire immediately
      expect(validateCSRFToken(token, testSessionId, 0)).toBe(false)
    })

    it('validateCSRFToken_withExtendedMaxAge_allowsLongerValidity', () => {
      // Arrange: Use fake timers
      vi.useFakeTimers()
      const startTime = new Date('2024-01-15T12:00:00Z')
      vi.setSystemTime(startTime)

      const token = generateCSRFToken(testSessionId)

      // Advance 23 hours - should still be valid with 24 hour maxAge
      vi.advanceTimersByTime(23 * 60 * 60 * 1000)
      expect(validateCSRFToken(token, testSessionId, 86400)).toBe(true)

      // Advance past 24 hours - should be expired
      vi.advanceTimersByTime(2 * 60 * 60 * 1000)
      expect(validateCSRFToken(token, testSessionId, 86400)).toBe(false)
    })

    it('handles non-numeric timestamp gracefully', () => {
      const token = 'value.notanumber.signature'
      const isValid = validateCSRFToken(token, testSessionId)

      expect(isValid).toBe(false)
    })

    /**
     * REVIEW: Timing-safe comparison is a security implementation detail.
     * This test verifies normal operation; actual timing safety requires
     * statistical timing analysis which is out of scope for unit tests.
     * The implementation uses crypto.timingSafeEqual which is trusted.
     */
    it('validateCSRFToken_withValidToken_operatesCorrectly', () => {
      // This test verifies the signature comparison path works correctly
      // The timing-safe property is provided by Node's crypto.timingSafeEqual
      const token = generateCSRFToken(testSessionId)
      const isValid = validateCSRFToken(token, testSessionId)
      expect(isValid).toBe(true)
    })

    it('validateCSRFToken_signatureBufferLengthMismatch_returnsFalse', () => {
      // Tokens with truncated or extended signatures should fail validation
      const token = generateCSRFToken(testSessionId)
      const parts = token.split('.')

      // Truncate signature (remove last 4 chars to change buffer length)
      parts[2] = parts[2].substring(0, parts[2].length - 8) // 4 fewer hex chars = 2 fewer bytes
      const truncatedToken = parts.join('.')
      expect(validateCSRFToken(truncatedToken, testSessionId)).toBe(false)

      // Extend signature (add extra chars)
      const extendedParts = token.split('.')
      extendedParts[2] = extendedParts[2] + 'abcd1234'
      const extendedToken = extendedParts.join('.')
      expect(validateCSRFToken(extendedToken, testSessionId)).toBe(false)
    })
  })

  describe('CSRF protection workflow', () => {
    it('full workflow: use session ID, create token, validate token', () => {
      // Session ID comes from sessionService.validateSession() in the real flow
      const sessionId = 'ps_sess_abc123def456'

      // Step 1: Generate CSRF token for session
      const csrfToken = generateCSRFToken(sessionId)

      // Step 2: Validate token
      const isValid = validateCSRFToken(csrfToken, sessionId)

      expect(isValid).toBe(true)
    })

    it('token invalidation when session ID changes', () => {
      const sessionId1 = 'ps_sess_original'
      const csrfToken = generateCSRFToken(sessionId1)

      // New session ID (e.g., after re-authentication)
      const sessionId2 = 'ps_sess_new'

      // Old CSRF token should not validate with new session
      const isValid = validateCSRFToken(csrfToken, sessionId2)
      expect(isValid).toBe(false)
    })
  })

  describe('replay attack prevention', () => {
    it('validateCSRFToken_tokenOlderThanMaxAge_rejectsToPreventReplay', () => {
      // Arrange: Use fake timers for deterministic testing
      vi.useFakeTimers()
      const startTime = new Date('2024-01-15T12:00:00Z')
      vi.setSystemTime(startTime)

      const token = generateCSRFToken(testSessionId)

      // Act: Token is valid immediately
      expect(validateCSRFToken(token, testSessionId, 10)).toBe(true)

      // Advance time past maxAge
      vi.advanceTimersByTime(11 * 1000) // 11 seconds

      // Assert: Token expired, replay attack prevented
      expect(validateCSRFToken(token, testSessionId, 10)).toBe(false)
    })

    it('validateCSRFToken_tokenWithFutureTimestamp_rejectsDueToInvalidSignature', () => {
      // This test verifies that tampering with the timestamp breaks the signature
      const token = generateCSRFToken(testSessionId)
      const parts = token.split('.')

      // Set timestamp to future - this invalidates the HMAC signature
      const futureTimestamp = Math.floor(Date.now() / 1000) + 1000
      parts[1] = futureTimestamp.toString()
      const futureToken = parts.join('.')

      // Token is rejected because signature doesn't match tampered timestamp
      const isValid = validateCSRFToken(futureToken, testSessionId)
      expect(isValid).toBe(false)
    })

    it('validateCSRFToken_sameTokenUsedTwice_remainsValidUntilExpiry', () => {
      // REVIEW: CSRF tokens in this implementation can be reused within their validity window.
      // This is acceptable for the synchronizer token pattern as the token is bound to the session.
      // If single-use tokens are required, the application layer must track used tokens.
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2024-01-15T12:00:00Z'))

      const token = generateCSRFToken(testSessionId)

      // Same token can be validated multiple times within validity window
      expect(validateCSRFToken(token, testSessionId)).toBe(true)
      expect(validateCSRFToken(token, testSessionId)).toBe(true)

      // Advance halfway through validity
      vi.advanceTimersByTime(1800 * 1000) // 30 minutes
      expect(validateCSRFToken(token, testSessionId)).toBe(true)

      // Advance past validity
      vi.advanceTimersByTime(1801 * 1000) // Past 1 hour total
      expect(validateCSRFToken(token, testSessionId)).toBe(false)
    })
  })

  describe('error handling', () => {
    it('validateCSRFToken_withNullToken_returnsFalseWithoutThrowing', () => {
      expect(() => validateCSRFToken(null as never, testSessionId)).not.toThrow()
      expect(validateCSRFToken(null as never, testSessionId)).toBe(false)
    })

    it('validateCSRFToken_withUndefinedToken_returnsFalseWithoutThrowing', () => {
      expect(() => validateCSRFToken(undefined as never, testSessionId)).not.toThrow()
      expect(validateCSRFToken(undefined as never, testSessionId)).toBe(false)
    })

    it('validateCSRFToken_withObjectToken_returnsFalseWithoutThrowing', () => {
      expect(() => validateCSRFToken({} as never, testSessionId)).not.toThrow()
      expect(validateCSRFToken({} as never, testSessionId)).toBe(false)
    })

    it('validateCSRFToken_withNumberToken_returnsFalseWithoutThrowing', () => {
      expect(() => validateCSRFToken(12345 as never, testSessionId)).not.toThrow()
      expect(validateCSRFToken(12345 as never, testSessionId)).toBe(false)
    })

    it('validateCSRFToken_withArrayToken_returnsFalseWithoutThrowing', () => {
      expect(() => validateCSRFToken(['a', 'b', 'c'] as never, testSessionId)).not.toThrow()
      expect(validateCSRFToken(['a', 'b', 'c'] as never, testSessionId)).toBe(false)
    })

    it('validateCSRFToken_withNullSessionId_returnsFalse', () => {
      const token = generateCSRFToken(testSessionId)
      expect(validateCSRFToken(token, null as never)).toBe(false)
    })

    it('validateCSRFToken_withUndefinedSessionId_returnsFalse', () => {
      const token = generateCSRFToken(testSessionId)
      expect(validateCSRFToken(token, undefined as never)).toBe(false)
    })
  })

  describe('cross-session attack prevention', () => {
    it('validateCSRFToken_tokenFromDifferentSession_rejects', () => {
      // This is the core CSRF protection: tokens are bound to a specific session
      const session1 = 'user_alice_session'
      const session2 = 'user_bob_session'

      // Generate token for Alice's session
      const aliceToken = generateCSRFToken(session1)

      // Token should not validate for Bob's session (cross-session attack)
      expect(validateCSRFToken(aliceToken, session2)).toBe(false)

      // Token should still validate for Alice's session
      expect(validateCSRFToken(aliceToken, session1)).toBe(true)
    })

    it('validateCSRFToken_stolenTokenUsedWithDifferentSession_rejects', () => {
      // Simulates scenario where attacker obtains a valid token but tries to use
      // it with their own session
      const victimSessionId = 'ps_sess_victim_abc123'
      const attackerSessionId = 'ps_sess_attacker_xyz789'

      // Victim's valid CSRF token
      const victimToken = generateCSRFToken(victimSessionId)

      // Attacker cannot use victim's token with their own session
      expect(validateCSRFToken(victimToken, attackerSessionId)).toBe(false)

      // Victim's token is still valid for victim's session
      expect(validateCSRFToken(victimToken, victimSessionId)).toBe(true)
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
