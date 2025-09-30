import { generateAccessToken, generateRefreshToken } from '../auth-utils'
import * as jose from 'jose'

export const authHelpers = {
  async createTestToken(userId: string, role: 'user' | 'admin' = 'user') {
    return generateAccessToken(userId, 0, role)
  },

  async createExpiredToken(userId: string) {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET!)
    return await new jose.SignJWT({ userId, tokenVersion: 0, role: 'user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(process.env.JWT_ISSUER!)
      .setAudience(process.env.JWT_AUDIENCE!)
      .setExpirationTime('1s')
      .sign(secret)
  },

  async createInvalidSignatureToken(userId: string) {
    const wrongSecret = new TextEncoder().encode('wrong-secret-key-that-is-long-enough')
    return await new jose.SignJWT({ userId, tokenVersion: 0, role: 'user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(process.env.JWT_ISSUER!)
      .setAudience(process.env.JWT_AUDIENCE!)
      .setExpirationTime('15m')
      .sign(wrongSecret)
  },

  async createMalformedToken() {
    return 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.invalid.signature'
  },
}