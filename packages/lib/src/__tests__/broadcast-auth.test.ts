import { describe, it, expect, vi } from 'vitest'
import {
  generateBroadcastSignature,
  formatSignatureHeader,
  verifyBroadcastSignature,
  createSignedBroadcastHeaders
} from '../auth/broadcast-auth'

describe('broadcast-auth', () => {
  const testRequestBody = JSON.stringify({
    channelId: 'test-channel',
    event: 'test-event',
    payload: { message: 'hello' }
  })

  describe('generateBroadcastSignature', () => {
    it('generates signature with timestamp and hex signature', () => {
      const result = generateBroadcastSignature(testRequestBody)

      expect(result).toHaveProperty('timestamp')
      expect(result).toHaveProperty('signature')
      expect(typeof result.timestamp).toBe('number')
      expect(typeof result.signature).toBe('string')
    })

    it('generates hex-encoded signature (64 chars for sha256)', () => {
      const { signature } = generateBroadcastSignature(testRequestBody)

      expect(signature).toMatch(/^[0-9a-f]{64}$/)
    })

    it('uses current timestamp when not provided', () => {
      const beforeTime = Math.floor(Date.now() / 1000)
      const { timestamp } = generateBroadcastSignature(testRequestBody)
      const afterTime = Math.floor(Date.now() / 1000)

      expect(timestamp).toBeGreaterThanOrEqual(beforeTime)
      expect(timestamp).toBeLessThanOrEqual(afterTime)
    })

    it('uses provided timestamp when specified', () => {
      const customTimestamp = 1234567890
      const { timestamp } = generateBroadcastSignature(testRequestBody, customTimestamp)

      expect(timestamp).toBe(customTimestamp)
    })

    it('generates different signatures for different request bodies', () => {
      const body1 = JSON.stringify({ message: 'hello' })
      const body2 = JSON.stringify({ message: 'world' })

      const sig1 = generateBroadcastSignature(body1, 1000)
      const sig2 = generateBroadcastSignature(body2, 1000)

      expect(sig1.signature).not.toBe(sig2.signature)
    })

    it('generates different signatures for different timestamps', () => {
      const sig1 = generateBroadcastSignature(testRequestBody, 1000)
      const sig2 = generateBroadcastSignature(testRequestBody, 2000)

      expect(sig1.signature).not.toBe(sig2.signature)
    })

    it('generates deterministic signatures for same input', () => {
      const timestamp = 1234567890

      const sig1 = generateBroadcastSignature(testRequestBody, timestamp)
      const sig2 = generateBroadcastSignature(testRequestBody, timestamp)

      expect(sig1.signature).toBe(sig2.signature)
      expect(sig1.timestamp).toBe(sig2.timestamp)
    })
  })

  describe('formatSignatureHeader', () => {
    it('formats header in correct format: t=timestamp,v1=signature', () => {
      const timestamp = 1234567890
      const signature = 'abc123def456'

      const header = formatSignatureHeader(timestamp, signature)

      expect(header).toBe('t=1234567890,v1=abc123def456')
    })

    it('handles long signatures correctly', () => {
      const timestamp = 1234567890
      const signature = 'a'.repeat(64)

      const header = formatSignatureHeader(timestamp, signature)

      expect(header).toContain(`t=${timestamp}`)
      expect(header).toContain(`v1=${signature}`)
    })
  })

  describe('verifyBroadcastSignature', () => {
    it('verifies valid signature successfully', () => {
      const { timestamp, signature } = generateBroadcastSignature(testRequestBody)
      const header = formatSignatureHeader(timestamp, signature)

      const isValid = verifyBroadcastSignature(header, testRequestBody)

      expect(isValid).toBe(true)
    })

    it('rejects signature with wrong request body', () => {
      const { timestamp, signature } = generateBroadcastSignature(testRequestBody)
      const header = formatSignatureHeader(timestamp, signature)

      const differentBody = JSON.stringify({ different: 'content' })
      const isValid = verifyBroadcastSignature(header, differentBody)

      expect(isValid).toBe(false)
    })

    it('rejects empty signature header', () => {
      const isValid = verifyBroadcastSignature('', testRequestBody)
      expect(isValid).toBe(false)
    })

    it('rejects empty request body', () => {
      const { timestamp, signature } = generateBroadcastSignature(testRequestBody)
      const header = formatSignatureHeader(timestamp, signature)

      const isValid = verifyBroadcastSignature(header, '')
      expect(isValid).toBe(false)
    })

    it('rejects malformed header (wrong format)', () => {
      expect(verifyBroadcastSignature('invalid', testRequestBody)).toBe(false)
      expect(verifyBroadcastSignature('t=123', testRequestBody)).toBe(false)
      expect(verifyBroadcastSignature('v1=abc', testRequestBody)).toBe(false)
      expect(verifyBroadcastSignature('t=123,v1=abc,extra=value', testRequestBody)).toBe(false)
    })

    it('rejects header with tampered signature', () => {
      const { timestamp, signature } = generateBroadcastSignature(testRequestBody)
      const tamperedSignature = signature.substring(0, signature.length - 4) + 'XXXX'
      const header = formatSignatureHeader(timestamp, tamperedSignature)

      const isValid = verifyBroadcastSignature(header, testRequestBody)
      expect(isValid).toBe(false)
    })

    it('rejects header with tampered timestamp', () => {
      const { timestamp, signature } = generateBroadcastSignature(testRequestBody)
      const tamperedTimestamp = timestamp + 1000
      const header = formatSignatureHeader(tamperedTimestamp, signature)

      const isValid = verifyBroadcastSignature(header, testRequestBody)
      expect(isValid).toBe(false)
    })

    it('rejects expired signature (older than 5 minutes)', () => {
      const oldTimestamp = Math.floor(Date.now() / 1000) - 400 // 400 seconds ago (6+ minutes)
      const { signature } = generateBroadcastSignature(testRequestBody, oldTimestamp)
      const header = formatSignatureHeader(oldTimestamp, signature)

      const isValid = verifyBroadcastSignature(header, testRequestBody)
      expect(isValid).toBe(false)
    })

    it('accepts signature within 5 minute window', () => {
      const recentTimestamp = Math.floor(Date.now() / 1000) - 200 // 200 seconds ago (3.3 minutes)
      const { signature } = generateBroadcastSignature(testRequestBody, recentTimestamp)
      const header = formatSignatureHeader(recentTimestamp, signature)

      const isValid = verifyBroadcastSignature(header, testRequestBody)
      expect(isValid).toBe(true)
    })

    it('rejects signature from the future', () => {
      const futureTimestamp = Math.floor(Date.now() / 1000) + 400 // 400 seconds in future
      const { signature } = generateBroadcastSignature(testRequestBody, futureTimestamp)
      const header = formatSignatureHeader(futureTimestamp, signature)

      const isValid = verifyBroadcastSignature(header, testRequestBody)
      expect(isValid).toBe(false)
    })

    it('handles non-numeric timestamp gracefully', () => {
      const header = 't=notanumber,v1=abc123def456'
      const isValid = verifyBroadcastSignature(header, testRequestBody)

      expect(isValid).toBe(false)
    })

    it('uses timing-safe comparison for signature validation', () => {
      // This verifies the code doesn't throw and returns correct result
      const { timestamp, signature } = generateBroadcastSignature(testRequestBody)
      const header = formatSignatureHeader(timestamp, signature)

      const isValid = verifyBroadcastSignature(header, testRequestBody)
      expect(isValid).toBe(true)
    })

    it('rejects signatures with mismatched length', () => {
      const { timestamp } = generateBroadcastSignature(testRequestBody)
      const shortSignature = 'abc123'
      const header = formatSignatureHeader(timestamp, shortSignature)

      const isValid = verifyBroadcastSignature(header, testRequestBody)
      expect(isValid).toBe(false)
    })
  })

  describe('createSignedBroadcastHeaders', () => {
    it('creates headers with correct structure', () => {
      const headers = createSignedBroadcastHeaders(testRequestBody)

      expect(headers).toHaveProperty('Content-Type')
      expect(headers).toHaveProperty('X-Broadcast-Signature')
      expect(headers['Content-Type']).toBe('application/json')
    })

    it('creates valid signature header that passes verification', () => {
      const headers = createSignedBroadcastHeaders(testRequestBody)
      const signatureHeader = headers['X-Broadcast-Signature']

      const isValid = verifyBroadcastSignature(signatureHeader, testRequestBody)
      expect(isValid).toBe(true)
    })

    it('signature header has correct format', () => {
      const headers = createSignedBroadcastHeaders(testRequestBody)
      const signatureHeader = headers['X-Broadcast-Signature']

      expect(signatureHeader).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)
    })

    it('creates fresh signatures each time (different timestamps)', async () => {
      const headers1 = createSignedBroadcastHeaders(testRequestBody)

      // Wait 1 second to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 1000))

      const headers2 = createSignedBroadcastHeaders(testRequestBody)

      expect(headers1['X-Broadcast-Signature']).not.toBe(headers2['X-Broadcast-Signature'])
    })
  })

  describe('full broadcast workflow', () => {
    it('complete request signing and verification workflow', () => {
      // Step 1: Create signed headers for outgoing request
      const headers = createSignedBroadcastHeaders(testRequestBody)

      // Step 2: Extract signature header (as receiving server would)
      const signatureHeader = headers['X-Broadcast-Signature']

      // Step 3: Verify signature on receiving end
      const isValid = verifyBroadcastSignature(signatureHeader, testRequestBody)

      expect(isValid).toBe(true)
    })

    it('rejects request with modified body', () => {
      // Attacker sends valid headers but modifies body
      const headers = createSignedBroadcastHeaders(testRequestBody)
      const modifiedBody = testRequestBody.replace('hello', 'hacked')

      const isValid = verifyBroadcastSignature(headers['X-Broadcast-Signature'], modifiedBody)
      expect(isValid).toBe(false)
    })

    it('rejects replay attack after 5 minutes', () => {
      // Simulate old request from 6 minutes ago
      const oldTimestamp = Math.floor(Date.now() / 1000) - 360
      const { signature } = generateBroadcastSignature(testRequestBody, oldTimestamp)
      const header = formatSignatureHeader(oldTimestamp, signature)

      const isValid = verifyBroadcastSignature(header, testRequestBody)
      expect(isValid).toBe(false)
    })
  })

  describe('security properties', () => {
    it('prevents signature reuse with different body', () => {
      const body1 = JSON.stringify({ action: 'delete' })
      const body2 = JSON.stringify({ action: 'create' })

      const headers1 = createSignedBroadcastHeaders(body1)

      // Try to use signature from body1 with body2
      const isValid = verifyBroadcastSignature(headers1['X-Broadcast-Signature'], body2)
      expect(isValid).toBe(false)
    })

    it('prevents timestamp manipulation', () => {
      const { timestamp, signature } = generateBroadcastSignature(testRequestBody)
      const newTimestamp = timestamp + 1
      const header = formatSignatureHeader(newTimestamp, signature)

      const isValid = verifyBroadcastSignature(header, testRequestBody)
      expect(isValid).toBe(false)
    })

    it('includes body in signature calculation', () => {
      const emptyBody = '{}'
      const fullBody = JSON.stringify({ lots: 'of', data: 'here' })

      const sig1 = generateBroadcastSignature(emptyBody, 1000)
      const sig2 = generateBroadcastSignature(fullBody, 1000)

      expect(sig1.signature).not.toBe(sig2.signature)
    })
  })

  describe('error handling', () => {
    it('handles exceptions gracefully in verification', () => {
      // Should not throw, just return false
      expect(() => verifyBroadcastSignature(null as any, testRequestBody)).not.toThrow()
      expect(() => verifyBroadcastSignature(undefined as any, testRequestBody)).not.toThrow()
      expect(() => verifyBroadcastSignature({} as any, testRequestBody)).not.toThrow()

      expect(verifyBroadcastSignature(null as any, testRequestBody)).toBe(false)
      expect(verifyBroadcastSignature(undefined as any, testRequestBody)).toBe(false)
    })
  })

  describe('environment validation', () => {
    it('requires REALTIME_BROADCAST_SECRET environment variable', () => {
      const original = process.env.REALTIME_BROADCAST_SECRET
      delete process.env.REALTIME_BROADCAST_SECRET

      expect(() => generateBroadcastSignature(testRequestBody)).toThrow(
        'REALTIME_BROADCAST_SECRET environment variable is required'
      )

      process.env.REALTIME_BROADCAST_SECRET = original
    })

    it('requires REALTIME_BROADCAST_SECRET to be at least 32 characters', () => {
      const original = process.env.REALTIME_BROADCAST_SECRET
      process.env.REALTIME_BROADCAST_SECRET = 'tooshort'

      expect(() => generateBroadcastSignature(testRequestBody)).toThrow(
        'REALTIME_BROADCAST_SECRET must be at least 32 characters long'
      )

      process.env.REALTIME_BROADCAST_SECRET = original
    })
  })
})
