import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../../app'

const API_KEY = 'test-api-key-secret'

function makeMocks() {
  return {
    repo: {
      createTenant: vi.fn(),
      getTenantBySlug: vi.fn(),
      getTenantById: vi.fn(),
      getTenantByStripeSubscription: vi.fn(),
      listTenants: vi.fn().mockResolvedValue([]),
      updateTenantStatus: vi.fn(),
      updateHealthStatus: vi.fn(),
      deleteTenant: vi.fn(),
      recordEvent: vi.fn(),
      getRecentEvents: vi.fn().mockResolvedValue([]),
    },
    provisioningEngine: {
      provision: vi.fn().mockResolvedValue({ tenantId: 'new-id' }),
    },
    lifecycle: {
      suspend: vi.fn(),
      resume: vi.fn(),
      upgrade: vi.fn(),
      destroy: vi.fn(),
    },
    stripe: {
      webhooks: {
        constructEvent: vi.fn(),
      },
      checkout: {
        sessions: {
          create: vi.fn().mockResolvedValue({
            id: 'cs_test_123',
            url: 'https://checkout.stripe.com/cs_test_123',
          }),
        },
      },
      billingPortal: {
        sessions: {
          create: vi.fn().mockResolvedValue({
            id: 'bps_test_123',
            url: 'https://billing.stripe.com/session/bps_test_123',
          }),
        },
      },
    },
  }
}

function buildApp(mocks = makeMocks()) {
  process.env.CONTROL_PLANE_API_KEY = API_KEY
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test'
  return {
    app: createApp({ logger: false, ...mocks }),
    ...mocks,
  }
}

function authHeaders() {
  return { 'x-api-key': API_KEY }
}

function makeTenant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tenant-1',
    slug: 'acme-corp',
    name: 'Acme Corp',
    status: 'active',
    tier: 'pro',
    ownerEmail: 'admin@acme.com',
    stripeCustomerId: 'cus_abc123',
    stripeSubscriptionId: 'sub_abc123',
    ...overrides,
  }
}

describe('billing routes', () => {
  beforeEach(() => {
    process.env.CONTROL_PLANE_API_KEY = API_KEY
  })

  // ──────────────────────────────────────────────
  // POST /api/billing/checkout
  // ──────────────────────────────────────────────
  describe('POST /api/billing/checkout', () => {
    it('given valid input, should create Stripe checkout session', async () => {
      const mocks = makeMocks()
      mocks.repo.getTenantBySlug.mockResolvedValue(null)

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/checkout',
        headers: authHeaders(),
        payload: { slug: 'acme-corp', email: 'owner@acme.com', tier: 'pro' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.url).toBe('https://checkout.stripe.com/cs_test_123')
      expect(body.sessionId).toBe('cs_test_123')
    })

    it('given valid input, should pass correct params to Stripe', async () => {
      const mocks = makeMocks()
      mocks.repo.getTenantBySlug.mockResolvedValue(null)

      const { app } = buildApp(mocks)

      await app.inject({
        method: 'POST',
        url: '/api/billing/checkout',
        headers: authHeaders(),
        payload: { slug: 'acme-corp', email: 'owner@acme.com', tier: 'pro' },
      })

      expect(mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'subscription',
          customer_email: 'owner@acme.com',
          metadata: expect.objectContaining({ slug: 'acme-corp', tier: 'pro' }),
          success_url: 'https://acme-corp.pagespace.ai',
          cancel_url: 'https://pagespace.ai',
        })
      )
    })

    it('given duplicate slug, should return 409 without calling Stripe', async () => {
      const mocks = makeMocks()
      mocks.repo.getTenantBySlug.mockResolvedValue(makeTenant())

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/checkout',
        headers: authHeaders(),
        payload: { slug: 'acme-corp', email: 'owner@acme.com', tier: 'pro' },
      })

      expect(response.statusCode).toBe(409)
      expect(response.json().error).toMatch(/already/i)
      expect(mocks.stripe.checkout.sessions.create).not.toHaveBeenCalled()
    })

    it('given invalid slug format, should return 400', async () => {
      const { app } = buildApp()

      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/checkout',
        headers: authHeaders(),
        payload: { slug: 'AB', email: 'owner@acme.com', tier: 'pro' },
      })

      expect(response.statusCode).toBe(400)
    })

    it('given invalid email, should return 400', async () => {
      const { app } = buildApp()

      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/checkout',
        headers: authHeaders(),
        payload: { slug: 'valid-slug', email: 'not-email', tier: 'pro' },
      })

      expect(response.statusCode).toBe(400)
    })

    it('given invalid tier, should return 400', async () => {
      const { app } = buildApp()

      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/checkout',
        headers: authHeaders(),
        payload: { slug: 'valid-slug', email: 'a@b.com', tier: 'ultra-mega' },
      })

      expect(response.statusCode).toBe(400)
    })

    it('given missing fields, should return 400', async () => {
      const { app } = buildApp()

      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/checkout',
        headers: authHeaders(),
        payload: { slug: 'valid-slug' },
      })

      expect(response.statusCode).toBe(400)
    })

    it('given no auth, should return 401', async () => {
      const { app } = buildApp()

      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/checkout',
        payload: { slug: 'acme-corp', email: 'a@b.com', tier: 'pro' },
      })

      expect(response.statusCode).toBe(401)
    })
  })

  // ──────────────────────────────────────────────
  // POST /api/billing/portal
  // ──────────────────────────────────────────────
  describe('POST /api/billing/portal', () => {
    it('given valid tenant with stripeCustomerId, should return portal URL', async () => {
      const mocks = makeMocks()
      mocks.repo.getTenantBySlug.mockResolvedValue(makeTenant())

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/portal',
        headers: authHeaders(),
        payload: { tenantSlug: 'acme-corp' },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json().url).toBe('https://billing.stripe.com/session/bps_test_123')
    })

    it('given valid tenant, should pass stripeCustomerId to Stripe', async () => {
      const mocks = makeMocks()
      mocks.repo.getTenantBySlug.mockResolvedValue(makeTenant())

      const { app } = buildApp(mocks)

      await app.inject({
        method: 'POST',
        url: '/api/billing/portal',
        headers: authHeaders(),
        payload: { tenantSlug: 'acme-corp' },
      })

      expect(mocks.stripe.billingPortal.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: 'cus_abc123',
        })
      )
    })

    it('given nonexistent tenant, should return 404', async () => {
      const mocks = makeMocks()
      mocks.repo.getTenantBySlug.mockResolvedValue(null)

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/portal',
        headers: authHeaders(),
        payload: { tenantSlug: 'no-such-tenant' },
      })

      expect(response.statusCode).toBe(404)
    })

    it('given tenant without stripeCustomerId, should return 400', async () => {
      const mocks = makeMocks()
      mocks.repo.getTenantBySlug.mockResolvedValue(
        makeTenant({ stripeCustomerId: null })
      )

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/portal',
        headers: authHeaders(),
        payload: { tenantSlug: 'acme-corp' },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toMatch(/stripe/i)
    })

    it('given missing tenantSlug, should return 400', async () => {
      const { app } = buildApp()

      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/portal',
        headers: authHeaders(),
        payload: {},
      })

      expect(response.statusCode).toBe(400)
    })

    it('given no auth, should return 401', async () => {
      const { app } = buildApp()

      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/portal',
        payload: { tenantSlug: 'acme-corp' },
      })

      expect(response.statusCode).toBe(401)
    })
  })
})
