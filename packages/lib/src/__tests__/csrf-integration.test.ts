import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { generateCSRFToken, validateCSRFToken } from '../auth/csrf-utils'

/**
 * CSRF Integration Tests
 *
 * These tests verify the complete CSRF token lifecycle without mocking
 * the crypto layer. They test the actual security properties of the
 * CSRF protection mechanism.
 *
 * Key security properties tested:
 * 1. Session binding - tokens are tied to server-validated session IDs
 * 2. Token integrity - tampering is detected via HMAC signature
 * 3. Expiration - tokens become invalid after maxAge
 * 4. Cross-session rejection - tokens from one session cannot be used in another
 */
describe('CSRF Integration Tests (no crypto mocking)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('full lifecycle: generate -> validate', () => {
    it('generatedToken_validatedImmediately_succeeds', () => {
      // This is the happy path: generate a token and validate it immediately
      // In the real flow, sessionId comes from sessionService.validateSession()
      const sessionId = 'ps_sess_abc123def456'

      // Step 1: Generate CSRF token for this session
      const csrfToken = generateCSRFToken(sessionId)
      expect(csrfToken).toBeTruthy()
      expect(csrfToken.split('.').length).toBe(3)

      // Step 2: Validate the token
      const isValid = validateCSRFToken(csrfToken, sessionId)
      expect(isValid).toBe(true)
    })

    it('generatedToken_validatedAfter30Minutes_succeeds', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2024-06-15T10:00:00Z'))

      const sessionId = 'ps_sess_test123'
      const csrfToken = generateCSRFToken(sessionId)

      // Advance 30 minutes (within default 1 hour maxAge)
      vi.advanceTimersByTime(30 * 60 * 1000)

      const isValid = validateCSRFToken(csrfToken, sessionId)
      expect(isValid).toBe(true)
    })

    it('generatedToken_validatedAfter1Hour_fails', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2024-06-15T10:00:00Z'))

      const sessionId = 'ps_sess_test123'
      const csrfToken = generateCSRFToken(sessionId)

      // Advance past 1 hour (default maxAge)
      vi.advanceTimersByTime(61 * 60 * 1000)

      const isValid = validateCSRFToken(csrfToken, sessionId)
      expect(isValid).toBe(false)
    })
  })

  describe('session binding security', () => {
    it('tokenFromSessionA_usedWithSessionB_rejects', () => {
      // Core CSRF protection: tokens are bound to specific sessions
      const sessionA = 'ps_sess_alice_abc123'
      const sessionB = 'ps_sess_bob_xyz789'

      // Generate token for Alice
      const aliceToken = generateCSRFToken(sessionA)

      // Bob cannot use Alice's token
      expect(validateCSRFToken(aliceToken, sessionB)).toBe(false)

      // Alice can still use her own token
      expect(validateCSRFToken(aliceToken, sessionA)).toBe(true)
    })

    it('tokenFromOldSession_afterReAuthentication_rejects', () => {
      // When user re-authenticates, they get a new session ID
      // Old CSRF tokens bound to old session become invalid
      const oldSessionId = 'ps_sess_old_abc123'
      const newSessionId = 'ps_sess_new_xyz789'

      const oldToken = generateCSRFToken(oldSessionId)

      // Old token is rejected with new session
      expect(validateCSRFToken(oldToken, newSessionId)).toBe(false)
    })

    it('tokenStillValidAfterSessionRefresh_ifSessionIdUnchanged', () => {
      // If the session is extended but keeps the same ID, tokens remain valid
      const sessionId = 'ps_sess_stable_abc123'

      const csrfToken = generateCSRFToken(sessionId)

      // Same session ID means token is still valid
      expect(validateCSRFToken(csrfToken, sessionId)).toBe(true)
    })
  })

  describe('token integrity protection', () => {
    it('tamperedTokenValue_rejects', () => {
      const sessionId = 'ps_sess_test123'
      const token = generateCSRFToken(sessionId)
      const [tokenValue, timestamp, signature] = token.split('.')

      // Tamper with the token value
      const tamperedValue = tokenValue.slice(0, -4) + 'dead'
      const tamperedToken = `${tamperedValue}.${timestamp}.${signature}`

      expect(validateCSRFToken(tamperedToken, sessionId)).toBe(false)
    })

    it('tamperedTimestamp_rejects', () => {
      const sessionId = 'ps_sess_test123'
      const token = generateCSRFToken(sessionId)
      const parts = token.split('.')

      // Tamper with the timestamp
      parts[1] = '9999999999'
      const tamperedToken = parts.join('.')

      expect(validateCSRFToken(tamperedToken, sessionId)).toBe(false)
    })

    it('tamperedSignature_rejects', () => {
      const sessionId = 'ps_sess_test123'
      const token = generateCSRFToken(sessionId)
      const parts = token.split('.')

      // Tamper with the signature
      parts[2] = parts[2].slice(0, -8) + 'deadbeef'
      const tamperedToken = parts.join('.')

      expect(validateCSRFToken(tamperedToken, sessionId)).toBe(false)
    })

    it('truncatedToken_rejects', () => {
      const sessionId = 'ps_sess_test123'
      const token = generateCSRFToken(sessionId)

      // Remove parts of the token
      expect(validateCSRFToken(token.split('.').slice(0, 2).join('.'), sessionId)).toBe(false)
      expect(validateCSRFToken(token.split('.')[0], sessionId)).toBe(false)
    })

    it('completelyFakeToken_rejects', () => {
      const sessionId = 'ps_sess_test123'

      // Attacker tries to forge a token with the right format but wrong signature
      const fakeToken = `${'a'.repeat(64)}.${Math.floor(Date.now() / 1000)}.${'b'.repeat(64)}`

      expect(validateCSRFToken(fakeToken, sessionId)).toBe(false)
    })
  })

  describe('uniqueness properties', () => {
    it('multipleTokensForSameSession_allValid', () => {
      const sessionId = 'ps_sess_test123'

      // Generate multiple tokens for the same session
      const token1 = generateCSRFToken(sessionId)
      const token2 = generateCSRFToken(sessionId)
      const token3 = generateCSRFToken(sessionId)

      // All should be different
      expect(token1).not.toBe(token2)
      expect(token2).not.toBe(token3)

      // All should be valid
      expect(validateCSRFToken(token1, sessionId)).toBe(true)
      expect(validateCSRFToken(token2, sessionId)).toBe(true)
      expect(validateCSRFToken(token3, sessionId)).toBe(true)
    })
  })

  describe('edge cases', () => {
    it('emptySessionId_throwsError', () => {
      // Security: empty session IDs are rejected upfront during generation
      // This prevents generating tokens that would never validate
      expect(() => generateCSRFToken('')).toThrow('Invalid sessionId: must be a non-empty string')
    })

    it('whitespaceOnlySessionId_throwsError', () => {
      // Security: whitespace-only session IDs are also rejected
      expect(() => generateCSRFToken('   ')).toThrow('Invalid sessionId: must be a non-empty string')
      expect(() => generateCSRFToken('\t\n')).toThrow('Invalid sessionId: must be a non-empty string')
    })

    it('specialCharactersInSessionId_handledCorrectly', () => {
      const sessionId = 'ps_sess_user@example.com_abc123'
      const token = generateCSRFToken(sessionId)
      expect(validateCSRFToken(token, sessionId)).toBe(true)
    })

    it('veryLongSessionId_handledCorrectly', () => {
      const sessionId = 'ps_sess_' + 'a'.repeat(1000)
      const token = generateCSRFToken(sessionId)
      expect(validateCSRFToken(token, sessionId)).toBe(true)
    })

    it('unicodeSessionId_handledCorrectly', () => {
      const sessionId = 'ps_sess_用户_123_🔒'
      const token = generateCSRFToken(sessionId)
      expect(validateCSRFToken(token, sessionId)).toBe(true)
    })
  })

  describe('boundary conditions', () => {
    it('tokenExpiringExactlyAtMaxAge_stillValid', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2024-06-15T10:00:00Z'))

      const sessionId = 'ps_sess_test123'
      const token = generateCSRFToken(sessionId)

      // Advance to exactly 3600 seconds (exactly at 1 hour default maxAge)
      vi.advanceTimersByTime(3600 * 1000)

      expect(validateCSRFToken(token, sessionId)).toBe(true)
    })

    it('tokenExpiring1SecondAfterMaxAge_invalid', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2024-06-15T10:00:00Z'))

      const sessionId = 'ps_sess_test123'
      const token = generateCSRFToken(sessionId)

      // Advance to 3601 seconds (1 second past default maxAge)
      vi.advanceTimersByTime(3601 * 1000)

      expect(validateCSRFToken(token, sessionId)).toBe(false)
    })

    it('customMaxAge_respectsConfiguration', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2024-06-15T10:00:00Z'))

      const sessionId = 'ps_sess_test123'
      const token = generateCSRFToken(sessionId)

      // With 5 minute maxAge (300 seconds)
      vi.advanceTimersByTime(299 * 1000) // 299 seconds
      expect(validateCSRFToken(token, sessionId, 300)).toBe(true)

      vi.advanceTimersByTime(2 * 1000) // Now 301 seconds total
      expect(validateCSRFToken(token, sessionId, 300)).toBe(false)
    })
  })
})
