import { describe, it, expect, afterEach } from 'vitest'
import Fastify from 'fastify'
import { apiKeyAuth } from '../api-key-auth'

const TEST_API_KEY = 'test-secret-key-12345'

function buildApp(apiKey?: string) {
  if (apiKey !== undefined) {
    process.env.CONTROL_PLANE_API_KEY = apiKey
  } else {
    delete process.env.CONTROL_PLANE_API_KEY
  }

  const app = Fastify()
  app.register(apiKeyAuth)

  // Protected route
  app.get('/api/tenants', async () => ({ tenants: [] }))
  app.post('/api/tenants', async () => ({ id: '1' }))

  // Health route (should bypass auth)
  app.get('/api/health', async () => ({ status: 'ok' }))

  return app
}

describe('apiKeyAuth middleware', () => {
  afterEach(() => {
    delete process.env.CONTROL_PLANE_API_KEY
  })

  describe('valid API key', () => {
    it('given a request with valid X-API-Key header, should allow the request', async () => {
      const app = buildApp(TEST_API_KEY)

      const response = await app.inject({
        method: 'GET',
        url: '/api/tenants',
        headers: { 'x-api-key': TEST_API_KEY },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ tenants: [] })
    })
  })

  describe('missing API key', () => {
    it('given a request with no X-API-Key header, should return 401', async () => {
      const app = buildApp(TEST_API_KEY)

      const response = await app.inject({
        method: 'GET',
        url: '/api/tenants',
      })

      expect(response.statusCode).toBe(401)
      expect(response.json()).toEqual({ error: 'Unauthorized' })
    })
  })

  describe('invalid API key', () => {
    it('given a request with wrong X-API-Key header, should return 401', async () => {
      const app = buildApp(TEST_API_KEY)

      const response = await app.inject({
        method: 'GET',
        url: '/api/tenants',
        headers: { 'x-api-key': 'wrong-key' },
      })

      expect(response.statusCode).toBe(401)
      expect(response.json()).toEqual({ error: 'Unauthorized' })
    })
  })

  describe('health endpoint bypass', () => {
    it('given GET /api/health with no API key, should not require auth', async () => {
      const app = buildApp(TEST_API_KEY)

      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ status: 'ok' })
    })
  })

  describe('missing server configuration', () => {
    it('given CONTROL_PLANE_API_KEY is not set, should return 401 for all protected routes', async () => {
      const app = buildApp(undefined)

      const response = await app.inject({
        method: 'GET',
        url: '/api/tenants',
        headers: { 'x-api-key': 'any-key' },
      })

      expect(response.statusCode).toBe(401)
      expect(response.json()).toEqual({ error: 'Unauthorized' })
    })
  })

  describe('POST routes', () => {
    it('given POST with valid API key, should allow the request', async () => {
      const app = buildApp(TEST_API_KEY)

      const response = await app.inject({
        method: 'POST',
        url: '/api/tenants',
        headers: { 'x-api-key': TEST_API_KEY },
        payload: {},
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ id: '1' })
    })

    it('given POST with no API key, should return 401', async () => {
      const app = buildApp(TEST_API_KEY)

      const response = await app.inject({
        method: 'POST',
        url: '/api/tenants',
        payload: {},
      })

      expect(response.statusCode).toBe(401)
    })
  })
})
