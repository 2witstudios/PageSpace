import { describe, it, expect } from 'vitest'
import { createApp } from '../app'

describe('GET /api/health', () => {
  it('should return 200 with status ok', async () => {
    const app = createApp()

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.status).toBe('ok')
  })

  it('should include a version string', async () => {
    const app = createApp()

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
    })

    const body = response.json()
    expect(body.version).toBeDefined()
    expect(typeof body.version).toBe('string')
  })

  it('should include service name', async () => {
    const app = createApp()

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
    })

    const body = response.json()
    expect(body.service).toBe('control-plane')
  })
})
