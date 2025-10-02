import { describe, it, expect } from 'vitest'
import { generateAccessToken, generateRefreshToken, decodeToken, isAdmin } from '../auth-utils'
import { authHelpers } from '../test/auth-helpers'

describe('auth-utils', () => {
  const testUserId = 'user_test123'
  const testTokenVersion = 0

  describe('generateAccessToken', () => {
    it('creates valid access token', async () => {
      const token = await generateAccessToken(testUserId, testTokenVersion, 'user')
      expect(token).toBeTruthy()
      expect(typeof token).toBe('string')

      const decoded = await decodeToken(token)
      expect(decoded).toBeTruthy()
      expect(decoded?.userId).toBe(testUserId)
      expect(decoded?.role).toBe('user')
    })

    it('creates admin token', async () => {
      const token = await generateAccessToken(testUserId, testTokenVersion, 'admin')
      const decoded = await decodeToken(token)

      expect(decoded?.role).toBe('admin')
      expect(isAdmin(decoded!)).toBe(true)
    })

    it('includes required JWT claims', async () => {
      const token = await generateAccessToken(testUserId, testTokenVersion, 'user')
      const decoded = await decodeToken(token)

      expect(decoded).toHaveProperty('iss')
      expect(decoded).toHaveProperty('aud')
      expect(decoded).toHaveProperty('exp')
      expect(decoded).toHaveProperty('iat')
    })

    it('includes issuer claim matching environment variable', async () => {
      const token = await generateAccessToken(testUserId, testTokenVersion, 'user')
      const decoded = await decodeToken(token)

      expect(decoded?.iss).toBe(process.env.JWT_ISSUER)
    })

    it('includes audience claim matching environment variable', async () => {
      const token = await generateAccessToken(testUserId, testTokenVersion, 'user')
      const decoded = await decodeToken(token)

      expect(decoded?.aud).toBe(process.env.JWT_AUDIENCE)
    })

    it('includes tokenVersion in payload', async () => {
      const token = await generateAccessToken(testUserId, 5, 'user')
      const decoded = await decodeToken(token)

      expect(decoded?.tokenVersion).toBe(5)
    })

    it('creates unique tokens for same user', async () => {
      const token1 = await generateAccessToken(testUserId, testTokenVersion, 'user')

      // Wait 1 second to ensure different iat claim (issued at timestamp)
      await new Promise(resolve => setTimeout(resolve, 1000))

      const token2 = await generateAccessToken(testUserId, testTokenVersion, 'user')

      expect(token1).not.toBe(token2)
    })
  })

  describe('generateRefreshToken', () => {
    it('creates valid refresh token', async () => {
      const token = await generateRefreshToken(testUserId, testTokenVersion, 'user')
      expect(token).toBeTruthy()

      const decoded = await decodeToken(token)
      expect(decoded?.userId).toBe(testUserId)
    })

    it('includes jti claim', async () => {
      const token = await generateRefreshToken(testUserId, testTokenVersion, 'user')
      const decoded = await decodeToken(token)

      expect(decoded).toHaveProperty('jti')
      expect(decoded?.jti).toBeTruthy()
    })

    it('creates unique jti for each token', async () => {
      const token1 = await generateRefreshToken(testUserId, testTokenVersion, 'user')
      const token2 = await generateRefreshToken(testUserId, testTokenVersion, 'user')

      const decoded1 = await decodeToken(token1)
      const decoded2 = await decodeToken(token2)

      expect(decoded1?.jti).not.toBe(decoded2?.jti)
    })

    it('includes all required claims', async () => {
      const token = await generateRefreshToken(testUserId, testTokenVersion, 'user')
      const decoded = await decodeToken(token)

      expect(decoded).toHaveProperty('userId')
      expect(decoded).toHaveProperty('tokenVersion')
      expect(decoded).toHaveProperty('role')
      expect(decoded).toHaveProperty('jti')
      expect(decoded).toHaveProperty('iss')
      expect(decoded).toHaveProperty('aud')
      expect(decoded).toHaveProperty('exp')
    })
  })

  describe('decodeToken', () => {
    it('decodes valid token successfully', async () => {
      const token = await generateAccessToken(testUserId, testTokenVersion, 'user')
      const decoded = await decodeToken(token)

      expect(decoded).not.toBeNull()
      expect(decoded?.userId).toBe(testUserId)
      expect(decoded?.tokenVersion).toBe(testTokenVersion)
      expect(decoded?.role).toBe('user')
    })

    it('rejects token with invalid signature', async () => {
      const invalidToken = await authHelpers.createInvalidSignatureToken(testUserId)
      const decoded = await decodeToken(invalidToken)

      expect(decoded).toBeNull()
    })

    it('rejects expired token', async () => {
      const expiredToken = await authHelpers.createExpiredToken(testUserId)

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1100))

      const decoded = await decodeToken(expiredToken)
      expect(decoded).toBeNull()
    })

    it('rejects malformed token', async () => {
      const malformed = await authHelpers.createMalformedToken()
      const decoded = await decodeToken(malformed)

      expect(decoded).toBeNull()
    })

    it('rejects token without required userId claim', async () => {
      const secret = new TextEncoder().encode(process.env.JWT_SECRET!)
      const { SignJWT } = await import('jose')

      const tokenWithoutUserId = await new SignJWT({ tokenVersion: 0, role: 'user' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(process.env.JWT_ISSUER!)
        .setAudience(process.env.JWT_AUDIENCE!)
        .setExpirationTime('15m')
        .sign(secret)

      const decoded = await decodeToken(tokenWithoutUserId)
      expect(decoded).toBeNull()
    })

    it('rejects token without required tokenVersion claim', async () => {
      const secret = new TextEncoder().encode(process.env.JWT_SECRET!)
      const { SignJWT } = await import('jose')

      const tokenWithoutVersion = await new SignJWT({ userId: testUserId, role: 'user' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(process.env.JWT_ISSUER!)
        .setAudience(process.env.JWT_AUDIENCE!)
        .setExpirationTime('15m')
        .sign(secret)

      const decoded = await decodeToken(tokenWithoutVersion)
      expect(decoded).toBeNull()
    })

    it('rejects token without required role claim', async () => {
      const secret = new TextEncoder().encode(process.env.JWT_SECRET!)
      const { SignJWT } = await import('jose')

      const tokenWithoutRole = await new SignJWT({ userId: testUserId, tokenVersion: 0 })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(process.env.JWT_ISSUER!)
        .setAudience(process.env.JWT_AUDIENCE!)
        .setExpirationTime('15m')
        .sign(secret)

      const decoded = await decodeToken(tokenWithoutRole)
      expect(decoded).toBeNull()
    })

    it('rejects token with invalid role value', async () => {
      const secret = new TextEncoder().encode(process.env.JWT_SECRET!)
      const { SignJWT } = await import('jose')

      const tokenWithInvalidRole = await new SignJWT({
        userId: testUserId,
        tokenVersion: 0,
        role: 'superadmin' // Invalid role
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(process.env.JWT_ISSUER!)
        .setAudience(process.env.JWT_AUDIENCE!)
        .setExpirationTime('15m')
        .sign(secret)

      const decoded = await decodeToken(tokenWithInvalidRole)
      expect(decoded).toBeNull()
    })

    it('rejects token with wrong issuer', async () => {
      const secret = new TextEncoder().encode(process.env.JWT_SECRET!)
      const { SignJWT } = await import('jose')

      const tokenWithWrongIssuer = await new SignJWT({
        userId: testUserId,
        tokenVersion: 0,
        role: 'user'
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer('wrong-issuer')
        .setAudience(process.env.JWT_AUDIENCE!)
        .setExpirationTime('15m')
        .sign(secret)

      const decoded = await decodeToken(tokenWithWrongIssuer)
      expect(decoded).toBeNull()
    })

    it('rejects token with wrong audience', async () => {
      const secret = new TextEncoder().encode(process.env.JWT_SECRET!)
      const { SignJWT } = await import('jose')

      const tokenWithWrongAudience = await new SignJWT({
        userId: testUserId,
        tokenVersion: 0,
        role: 'user'
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(process.env.JWT_ISSUER!)
        .setAudience('wrong-audience')
        .setExpirationTime('15m')
        .sign(secret)

      const decoded = await decodeToken(tokenWithWrongAudience)
      expect(decoded).toBeNull()
    })

    it('rejects empty token', async () => {
      const decoded = await decodeToken('')
      expect(decoded).toBeNull()
    })

    it('rejects token with invalid userId type', async () => {
      const secret = new TextEncoder().encode(process.env.JWT_SECRET!)
      const { SignJWT } = await import('jose')

      const tokenWithInvalidUserId = await new SignJWT({
        userId: 12345, // Should be string
        tokenVersion: 0,
        role: 'user'
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(process.env.JWT_ISSUER!)
        .setAudience(process.env.JWT_AUDIENCE!)
        .setExpirationTime('15m')
        .sign(secret)

      const decoded = await decodeToken(tokenWithInvalidUserId)
      expect(decoded).toBeNull()
    })
  })

  describe('isAdmin', () => {
    it('returns true for admin role', async () => {
      const token = await generateAccessToken(testUserId, testTokenVersion, 'admin')
      const decoded = await decodeToken(token)

      expect(isAdmin(decoded!)).toBe(true)
    })

    it('returns false for user role', async () => {
      const token = await generateAccessToken(testUserId, testTokenVersion, 'user')
      const decoded = await decodeToken(token)

      expect(isAdmin(decoded!)).toBe(false)
    })
  })

  describe('token security', () => {
    it('tokens are not reusable after tokenVersion increment', async () => {
      const token1 = await generateAccessToken(testUserId, 0, 'user')
      const token2 = await generateAccessToken(testUserId, 1, 'user')

      const decoded1 = await decodeToken(token1)
      const decoded2 = await decodeToken(token2)

      expect(decoded1?.tokenVersion).toBe(0)
      expect(decoded2?.tokenVersion).toBe(1)
      expect(decoded1?.tokenVersion).not.toBe(decoded2?.tokenVersion)
    })

    it('tokens for different users are completely independent', async () => {
      const user1Id = 'user_1'
      const user2Id = 'user_2'

      const token1 = await generateAccessToken(user1Id, 0, 'user')
      const token2 = await generateAccessToken(user2Id, 0, 'user')

      const decoded1 = await decodeToken(token1)
      const decoded2 = await decodeToken(token2)

      expect(decoded1?.userId).not.toBe(decoded2?.userId)
      expect(decoded1?.userId).toBe(user1Id)
      expect(decoded2?.userId).toBe(user2Id)
    })
  })
})