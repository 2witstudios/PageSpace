import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../../app'

const API_KEY = 'test-api-key-secret'

function makeTenant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tenant-1',
    slug: 'acme-corp',
    name: 'Acme Corp',
    status: 'active',
    tier: 'pro',
    ownerEmail: 'admin@acme.com',
    healthStatus: 'healthy',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    provisionedAt: null,
    lastHealthCheck: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    infraId: null,
    provider: 'docker',
    encryptedSecrets: null,
    resourceLimits: null,
    ...overrides,
  }
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-1',
    tenantId: 'tenant-1',
    eventType: 'provisioned',
    metadata: {},
    createdAt: new Date('2025-01-01'),
    ...overrides,
  }
}

function makeMocks() {
  return {
    repo: {
      createTenant: vi.fn(),
      getTenantBySlug: vi.fn(),
      getTenantById: vi.fn(),
      listTenants: vi.fn().mockResolvedValue([]),
      updateTenantStatus: vi.fn(),
      updateHealthStatus: vi.fn(),
      deleteTenant: vi.fn(),
      recordEvent: vi.fn(),
      getRecentEvents: vi.fn().mockResolvedValue([]),
    },
    provisioningEngine: {
      provision: vi.fn(),
    },
    lifecycle: {
      suspend: vi.fn(),
      resume: vi.fn(),
      upgrade: vi.fn(),
      destroy: vi.fn(),
    },
  }
}

function buildApp(mocks = makeMocks()) {
  process.env.CONTROL_PLANE_API_KEY = API_KEY
  return {
    app: createApp({ logger: false, ...mocks }),
    ...mocks,
  }
}

function authHeaders() {
  return { 'x-api-key': API_KEY }
}

describe('tenant routes', () => {
  beforeEach(() => {
    process.env.CONTROL_PLANE_API_KEY = API_KEY
  })

  // ──────────────────────────────────────────────
  // POST /api/tenants — validate + fire provision
  // ──────────────────────────────────────────────
  describe('POST /api/tenants', () => {
    it('given valid input, should return 202 and trigger async provisioning', async () => {
      const mocks = makeMocks()
      mocks.repo.getTenantBySlug.mockResolvedValue(null)
      mocks.provisioningEngine.provision.mockResolvedValue({ tenantId: 'new-id' })

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/tenants',
        headers: authHeaders(),
        payload: {
          slug: 'acme-corp',
          name: 'Acme Corp',
          ownerEmail: 'admin@acme.com',
          tier: 'pro',
        },
      })

      expect(response.statusCode).toBe(202)
      const body = response.json()
      expect(body.slug).toBe('acme-corp')
      expect(body.name).toBe('Acme Corp')
      expect(body.status).toBe('provisioning')
      // Route should NOT create tenant — engine owns that
      expect(mocks.repo.createTenant).not.toHaveBeenCalled()
      // Provisioning should be triggered (fire-and-forget)
      expect(mocks.provisioningEngine.provision).toHaveBeenCalledWith({
        slug: 'acme-corp',
        name: 'Acme Corp',
        ownerEmail: 'admin@acme.com',
        tier: 'pro',
      })
    })

    it('given no auth, should return 401', async () => {
      const { app } = buildApp()

      const response = await app.inject({
        method: 'POST',
        url: '/api/tenants',
        payload: {
          slug: 'acme-corp',
          name: 'Acme Corp',
          ownerEmail: 'admin@acme.com',
          tier: 'pro',
        },
      })

      expect(response.statusCode).toBe(401)
    })

    it('given duplicate slug, should return 409', async () => {
      const mocks = makeMocks()
      mocks.repo.getTenantBySlug.mockResolvedValue(makeTenant())

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/tenants',
        headers: authHeaders(),
        payload: {
          slug: 'acme-corp',
          name: 'Acme Corp',
          ownerEmail: 'admin@acme.com',
          tier: 'pro',
        },
      })

      expect(response.statusCode).toBe(409)
      expect(response.json().error).toMatch(/already exists/i)
    })

    it('given missing required fields, should return 400', async () => {
      const { app } = buildApp()

      const response = await app.inject({
        method: 'POST',
        url: '/api/tenants',
        headers: authHeaders(),
        payload: { slug: 'acme-corp' },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBeDefined()
    })

    it('given invalid slug format, should return 400', async () => {
      const { app } = buildApp()

      const response = await app.inject({
        method: 'POST',
        url: '/api/tenants',
        headers: authHeaders(),
        payload: {
          slug: 'AB',
          name: 'Bad',
          ownerEmail: 'a@b.com',
          tier: 'pro',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('given invalid email format, should return 400', async () => {
      const { app } = buildApp()

      const response = await app.inject({
        method: 'POST',
        url: '/api/tenants',
        headers: authHeaders(),
        payload: {
          slug: 'valid-slug',
          name: 'Valid Name',
          ownerEmail: 'not-an-email',
          tier: 'pro',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('given invalid tier, should return 400', async () => {
      const { app } = buildApp()

      const response = await app.inject({
        method: 'POST',
        url: '/api/tenants',
        headers: authHeaders(),
        payload: {
          slug: 'valid-slug',
          name: 'Valid Name',
          ownerEmail: 'a@b.com',
          tier: 'ultra-mega',
        },
      })

      expect(response.statusCode).toBe(400)
    })
  })

  // ──────────────────────────────────────────────
  // GET /api/tenants — list
  // ──────────────────────────────────────────────
  describe('GET /api/tenants', () => {
    it('given valid auth, should return list of tenants', async () => {
      const mocks = makeMocks()
      const tenantList = [makeTenant(), makeTenant({ id: 'tenant-2', slug: 'beta-co', name: 'Beta Co' })]
      mocks.repo.listTenants.mockResolvedValue(tenantList)

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'GET',
        url: '/api/tenants',
        headers: authHeaders(),
      })

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.tenants).toHaveLength(2)
      expect(body.tenants[0].slug).toBe('acme-corp')
    })

    it('given status query param, should filter by status', async () => {
      const mocks = makeMocks()
      mocks.repo.listTenants.mockResolvedValue([makeTenant({ status: 'active' })])

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'GET',
        url: '/api/tenants?status=active',
        headers: authHeaders(),
      })

      expect(response.statusCode).toBe(200)
      expect(mocks.repo.listTenants).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'active' })
      )
    })

    it('given invalid status query param, should return 400', async () => {
      const { app } = buildApp()

      const response = await app.inject({
        method: 'GET',
        url: '/api/tenants?status=bogus',
        headers: authHeaders(),
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toMatch(/invalid status/i)
    })

    it('given no auth, should return 401', async () => {
      const { app } = buildApp()

      const response = await app.inject({
        method: 'GET',
        url: '/api/tenants',
      })

      expect(response.statusCode).toBe(401)
    })
  })

  // ──────────────────────────────────────────────
  // GET /api/tenants/:slug — detail
  // ──────────────────────────────────────────────
  describe('GET /api/tenants/:slug', () => {
    it('given existing slug, should return tenant with recent events', async () => {
      const mocks = makeMocks()
      const tenant = makeTenant()
      const events = [makeEvent(), makeEvent({ id: 'event-2', eventType: 'resumed' })]
      mocks.repo.getTenantBySlug.mockResolvedValue(tenant)
      mocks.repo.getRecentEvents.mockResolvedValue(events)

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'GET',
        url: '/api/tenants/acme-corp',
        headers: authHeaders(),
      })

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.slug).toBe('acme-corp')
      expect(body.recentEvents).toHaveLength(2)
      expect(mocks.repo.getRecentEvents).toHaveBeenCalledWith(tenant.id, 20)
    })

    it('given nonexistent slug, should return 404', async () => {
      const mocks = makeMocks()
      mocks.repo.getTenantBySlug.mockResolvedValue(null)

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'GET',
        url: '/api/tenants/no-such-tenant',
        headers: authHeaders(),
      })

      expect(response.statusCode).toBe(404)
      expect(response.json().error).toMatch(/not found/i)
    })
  })

  // ──────────────────────────────────────────────
  // POST /api/tenants/:slug/suspend
  // ──────────────────────────────────────────────
  describe('POST /api/tenants/:slug/suspend', () => {
    it('given an active tenant, should suspend and return 200', async () => {
      const mocks = makeMocks()
      mocks.lifecycle.suspend.mockResolvedValue(undefined)
      const suspended = makeTenant({ status: 'suspended' })
      mocks.repo.getTenantBySlug.mockResolvedValue(suspended)

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/tenants/acme-corp/suspend',
        headers: authHeaders(),
      })

      expect(response.statusCode).toBe(200)
      expect(mocks.lifecycle.suspend).toHaveBeenCalledWith('acme-corp')
      expect(response.json().status).toBe('suspended')
    })

    it('given a suspended tenant, should return 409', async () => {
      const mocks = makeMocks()
      mocks.repo.getTenantBySlug.mockResolvedValue(makeTenant({ status: 'suspended' }))
      mocks.lifecycle.suspend.mockRejectedValue(new Error('Cannot transition from suspended to suspended'))

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/tenants/acme-corp/suspend',
        headers: authHeaders(),
      })

      expect(response.statusCode).toBe(409)
    })

    it('given nonexistent slug, should return 404', async () => {
      const mocks = makeMocks()
      mocks.repo.getTenantBySlug.mockResolvedValue(null)
      mocks.lifecycle.suspend.mockRejectedValue(new Error('Tenant "nope" not found'))

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/tenants/nope/suspend',
        headers: authHeaders(),
      })

      expect(response.statusCode).toBe(404)
    })

    it('given an invalid slug format, should return 400', async () => {
      const mocks = makeMocks()
      mocks.lifecycle.suspend.mockRejectedValue(new Error('Invalid slug: "AB"'))

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/tenants/AB/suspend',
        headers: authHeaders(),
      })

      expect(response.statusCode).toBe(400)
    })
  })

  // ──────────────────────────────────────────────
  // POST /api/tenants/:slug/resume
  // ──────────────────────────────────────────────
  describe('POST /api/tenants/:slug/resume', () => {
    it('given a suspended tenant, should resume and return 200', async () => {
      const mocks = makeMocks()
      mocks.lifecycle.resume.mockResolvedValue(undefined)
      const resumed = makeTenant({ status: 'active' })
      mocks.repo.getTenantBySlug.mockResolvedValue(resumed)

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/tenants/acme-corp/resume',
        headers: authHeaders(),
      })

      expect(response.statusCode).toBe(200)
      expect(mocks.lifecycle.resume).toHaveBeenCalledWith('acme-corp')
      expect(response.json().status).toBe('active')
    })

    it('given an active tenant, should return 409', async () => {
      const mocks = makeMocks()
      mocks.repo.getTenantBySlug.mockResolvedValue(makeTenant({ status: 'active' }))
      mocks.lifecycle.resume.mockRejectedValue(new Error('Cannot transition from active to active'))

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/tenants/acme-corp/resume',
        headers: authHeaders(),
      })

      expect(response.statusCode).toBe(409)
    })
  })

  // ──────────────────────────────────────────────
  // POST /api/tenants/:slug/upgrade
  // ──────────────────────────────────────────────
  describe('POST /api/tenants/:slug/upgrade', () => {
    it('given valid imageTag, should upgrade and return 200', async () => {
      const mocks = makeMocks()
      const tenant = makeTenant({ status: 'active' })
      mocks.repo.getTenantBySlug.mockResolvedValue(tenant)
      mocks.lifecycle.upgrade.mockResolvedValue(undefined)

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/tenants/acme-corp/upgrade',
        headers: authHeaders(),
        payload: { imageTag: 'v2.0.0' },
      })

      expect(response.statusCode).toBe(200)
      expect(mocks.lifecycle.upgrade).toHaveBeenCalledWith('acme-corp', 'v2.0.0')
    })

    it('given missing imageTag, should return 400', async () => {
      const { app } = buildApp()

      const response = await app.inject({
        method: 'POST',
        url: '/api/tenants/acme-corp/upgrade',
        headers: authHeaders(),
        payload: {},
      })

      expect(response.statusCode).toBe(400)
    })

    it('given nonexistent slug, should return 404', async () => {
      const mocks = makeMocks()
      mocks.repo.getTenantBySlug.mockResolvedValue(null)
      mocks.lifecycle.upgrade.mockRejectedValue(new Error('Tenant "nope" not found'))

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/tenants/nope/upgrade',
        headers: authHeaders(),
        payload: { imageTag: 'v2.0.0' },
      })

      expect(response.statusCode).toBe(404)
    })
  })

  // ──────────────────────────────────────────────
  // DELETE /api/tenants/:slug — async destruction
  // ──────────────────────────────────────────────
  describe('DELETE /api/tenants/:slug', () => {
    it('given an active tenant, should validate, fire-and-forget destroy, return 202', async () => {
      const mocks = makeMocks()
      mocks.repo.getTenantBySlug.mockResolvedValue(makeTenant({ status: 'active' }))
      // destroy is fire-and-forget so mock it but don't await it in route
      mocks.lifecycle.destroy.mockResolvedValue(undefined)

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/tenants/acme-corp',
        headers: authHeaders(),
      })

      expect(response.statusCode).toBe(202)
      expect(mocks.lifecycle.destroy).toHaveBeenCalledWith('acme-corp')
    })

    it('given nonexistent slug, should return 404', async () => {
      const mocks = makeMocks()
      mocks.repo.getTenantBySlug.mockResolvedValue(null)

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/tenants/nope',
        headers: authHeaders(),
      })

      expect(response.statusCode).toBe(404)
      // destroy should NOT be called when tenant doesn't exist
      expect(mocks.lifecycle.destroy).not.toHaveBeenCalled()
    })

    it('given a destroyed tenant, should return 409', async () => {
      const mocks = makeMocks()
      mocks.repo.getTenantBySlug.mockResolvedValue(makeTenant({ status: 'destroyed' }))

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/tenants/acme-corp',
        headers: authHeaders(),
      })

      expect(response.statusCode).toBe(409)
      // destroy should NOT be called when transition is invalid
      expect(mocks.lifecycle.destroy).not.toHaveBeenCalled()
    })
  })
})
