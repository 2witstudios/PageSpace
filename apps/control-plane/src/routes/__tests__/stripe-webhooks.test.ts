import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../../app'

const API_KEY = 'test-api-key-secret'
const WEBHOOK_SECRET = 'whsec_test_secret'

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
    },
  }
}

function buildApp(mocks = makeMocks()) {
  process.env.CONTROL_PLANE_API_KEY = API_KEY
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
  return {
    app: createApp({ logger: false, ...mocks }),
    ...mocks,
  }
}

function makeCheckoutEvent(metadata: Record<string, string> = {}) {
  return {
    type: 'checkout.session.completed',
    data: {
      object: {
        customer: 'cus_abc123',
        subscription: 'sub_abc123',
        customer_email: 'owner@acme.com',
        metadata: {
          slug: 'acme-corp',
          tier: 'pro',
          ...metadata,
        },
      },
    },
  }
}

function makeSubscriptionDeletedEvent(subscriptionId = 'sub_abc123') {
  return {
    type: 'customer.subscription.deleted',
    data: {
      object: {
        id: subscriptionId,
        customer: 'cus_abc123',
      },
    },
  }
}

function makePaymentFailedEvent(attemptCount: number, subscriptionId = 'sub_abc123') {
  return {
    type: 'invoice.payment_failed',
    data: {
      object: {
        subscription: subscriptionId,
        attempt_count: attemptCount,
      },
    },
  }
}

function makeSubscriptionUpdatedEvent(status: string, subscriptionId = 'sub_abc123') {
  return {
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: subscriptionId,
        status,
        customer: 'cus_abc123',
      },
    },
  }
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

describe('stripe webhook route', () => {
  beforeEach(() => {
    process.env.CONTROL_PLANE_API_KEY = API_KEY
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
  })

  // ──────────────────────────────────────────────
  // Signature verification
  // ──────────────────────────────────────────────
  describe('signature verification', () => {
    it('given invalid signature, should return 400 and not process', async () => {
      const mocks = makeMocks()
      mocks.stripe.webhooks.constructEvent.mockImplementation(() => {
        throw new Error('Invalid signature')
      })
      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/stripe',
        headers: { 'stripe-signature': 'bad_sig', 'content-type': 'application/json' },
        payload: '{}',
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toMatch(/signature/i)
      expect(mocks.provisioningEngine.provision).not.toHaveBeenCalled()
      expect(mocks.lifecycle.suspend).not.toHaveBeenCalled()
    })

    it('given no stripe-signature header, should return 400', async () => {
      const mocks = makeMocks()
      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/stripe',
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      })

      expect(response.statusCode).toBe(400)
    })
  })

  // ──────────────────────────────────────────────
  // Auth bypass — webhooks must NOT require API key
  // ──────────────────────────────────────────────
  describe('auth bypass', () => {
    it('given valid webhook signature but no API key, should process normally', async () => {
      const mocks = makeMocks()
      const event = { type: 'unknown.event', data: { object: {} } }
      mocks.stripe.webhooks.constructEvent.mockReturnValue(event)
      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/stripe',
        headers: { 'stripe-signature': 'valid_sig', 'content-type': 'application/json' },
        payload: '{}',
      })

      // Should NOT return 401 — webhook bypasses API key auth
      expect(response.statusCode).toBe(200)
    })
  })

  // ──────────────────────────────────────────────
  // checkout.session.completed
  // ──────────────────────────────────────────────
  describe('checkout.session.completed', () => {
    it('given valid metadata, should call provisioning engine with slug and email', async () => {
      const mocks = makeMocks()
      const event = makeCheckoutEvent()
      mocks.stripe.webhooks.constructEvent.mockReturnValue(event)
      mocks.repo.getTenantBySlug.mockResolvedValue(null)

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/stripe',
        headers: { 'stripe-signature': 'valid_sig', 'content-type': 'application/json' },
        payload: '{}',
      })

      expect(response.statusCode).toBe(200)
      expect(mocks.provisioningEngine.provision).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'acme-corp',
          ownerEmail: 'owner@acme.com',
          tier: 'pro',
        })
      )
    })

    it('given missing slug in metadata, should return 200 but not provision', async () => {
      const mocks = makeMocks()
      const event = makeCheckoutEvent({ slug: '' })
      event.data.object.metadata.slug = ''
      mocks.stripe.webhooks.constructEvent.mockReturnValue(event)

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/stripe',
        headers: { 'stripe-signature': 'valid_sig', 'content-type': 'application/json' },
        payload: '{}',
      })

      expect(response.statusCode).toBe(200)
      expect(mocks.provisioningEngine.provision).not.toHaveBeenCalled()
    })
  })

  // ──────────────────────────────────────────────
  // customer.subscription.deleted
  // ──────────────────────────────────────────────
  describe('customer.subscription.deleted', () => {
    it('given tenant found by subscription, should call suspend', async () => {
      const mocks = makeMocks()
      const event = makeSubscriptionDeletedEvent()
      mocks.stripe.webhooks.constructEvent.mockReturnValue(event)
      mocks.repo.getTenantByStripeSubscription.mockResolvedValue(makeTenant())

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/stripe',
        headers: { 'stripe-signature': 'valid_sig', 'content-type': 'application/json' },
        payload: '{}',
      })

      expect(response.statusCode).toBe(200)
      expect(mocks.repo.getTenantByStripeSubscription).toHaveBeenCalledWith('sub_abc123')
      expect(mocks.lifecycle.suspend).toHaveBeenCalledWith('acme-corp')
    })

    it('given no tenant found, should return 200 without suspending', async () => {
      const mocks = makeMocks()
      const event = makeSubscriptionDeletedEvent('sub_unknown')
      mocks.stripe.webhooks.constructEvent.mockReturnValue(event)
      mocks.repo.getTenantByStripeSubscription.mockResolvedValue(null)

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/stripe',
        headers: { 'stripe-signature': 'valid_sig', 'content-type': 'application/json' },
        payload: '{}',
      })

      expect(response.statusCode).toBe(200)
      expect(mocks.lifecycle.suspend).not.toHaveBeenCalled()
    })
  })

  // ──────────────────────────────────────────────
  // invoice.payment_failed
  // ──────────────────────────────────────────────
  describe('invoice.payment_failed', () => {
    it('given attempt_count >= 3, should suspend tenant', async () => {
      const mocks = makeMocks()
      const event = makePaymentFailedEvent(3)
      mocks.stripe.webhooks.constructEvent.mockReturnValue(event)
      mocks.repo.getTenantByStripeSubscription.mockResolvedValue(makeTenant())

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/stripe',
        headers: { 'stripe-signature': 'valid_sig', 'content-type': 'application/json' },
        payload: '{}',
      })

      expect(response.statusCode).toBe(200)
      expect(mocks.lifecycle.suspend).toHaveBeenCalledWith('acme-corp')
    })

    it('given attempt_count < 3, should record event but not suspend', async () => {
      const mocks = makeMocks()
      const event = makePaymentFailedEvent(1)
      mocks.stripe.webhooks.constructEvent.mockReturnValue(event)
      const tenant = makeTenant()
      mocks.repo.getTenantByStripeSubscription.mockResolvedValue(tenant)

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/stripe',
        headers: { 'stripe-signature': 'valid_sig', 'content-type': 'application/json' },
        payload: '{}',
      })

      expect(response.statusCode).toBe(200)
      expect(mocks.lifecycle.suspend).not.toHaveBeenCalled()
      expect(mocks.repo.recordEvent).toHaveBeenCalledWith(
        tenant.id,
        'payment_failed',
        expect.objectContaining({ attemptCount: 1 })
      )
    })

    it('given attempt_count = 2, should record event but not suspend', async () => {
      const mocks = makeMocks()
      const event = makePaymentFailedEvent(2)
      mocks.stripe.webhooks.constructEvent.mockReturnValue(event)
      const tenant = makeTenant()
      mocks.repo.getTenantByStripeSubscription.mockResolvedValue(tenant)

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/stripe',
        headers: { 'stripe-signature': 'valid_sig', 'content-type': 'application/json' },
        payload: '{}',
      })

      expect(response.statusCode).toBe(200)
      expect(mocks.lifecycle.suspend).not.toHaveBeenCalled()
      expect(mocks.repo.recordEvent).toHaveBeenCalled()
    })
  })

  // ──────────────────────────────────────────────
  // customer.subscription.updated — recovery
  // ──────────────────────────────────────────────
  describe('customer.subscription.updated', () => {
    it('given status=active and tenant is suspended, should resume', async () => {
      const mocks = makeMocks()
      const event = makeSubscriptionUpdatedEvent('active')
      mocks.stripe.webhooks.constructEvent.mockReturnValue(event)
      mocks.repo.getTenantByStripeSubscription.mockResolvedValue(
        makeTenant({ status: 'suspended' })
      )

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/stripe',
        headers: { 'stripe-signature': 'valid_sig', 'content-type': 'application/json' },
        payload: '{}',
      })

      expect(response.statusCode).toBe(200)
      expect(mocks.lifecycle.resume).toHaveBeenCalledWith('acme-corp')
    })

    it('given status=active but tenant is already active, should not resume', async () => {
      const mocks = makeMocks()
      const event = makeSubscriptionUpdatedEvent('active')
      mocks.stripe.webhooks.constructEvent.mockReturnValue(event)
      mocks.repo.getTenantByStripeSubscription.mockResolvedValue(
        makeTenant({ status: 'active' })
      )

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/stripe',
        headers: { 'stripe-signature': 'valid_sig', 'content-type': 'application/json' },
        payload: '{}',
      })

      expect(response.statusCode).toBe(200)
      expect(mocks.lifecycle.resume).not.toHaveBeenCalled()
    })

    it('given status=canceled, should not resume', async () => {
      const mocks = makeMocks()
      const event = makeSubscriptionUpdatedEvent('canceled')
      mocks.stripe.webhooks.constructEvent.mockReturnValue(event)

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/stripe',
        headers: { 'stripe-signature': 'valid_sig', 'content-type': 'application/json' },
        payload: '{}',
      })

      expect(response.statusCode).toBe(200)
      expect(mocks.lifecycle.resume).not.toHaveBeenCalled()
    })
  })

  // ──────────────────────────────────────────────
  // Unknown event type
  // ──────────────────────────────────────────────
  describe('unknown event', () => {
    it('given unknown event type, should return 200 and ignore', async () => {
      const mocks = makeMocks()
      const event = { type: 'some.unknown.event', data: { object: {} } }
      mocks.stripe.webhooks.constructEvent.mockReturnValue(event)

      const { app } = buildApp(mocks)

      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/stripe',
        headers: { 'stripe-signature': 'valid_sig', 'content-type': 'application/json' },
        payload: '{}',
      })

      expect(response.statusCode).toBe(200)
      expect(mocks.provisioningEngine.provision).not.toHaveBeenCalled()
      expect(mocks.lifecycle.suspend).not.toHaveBeenCalled()
      expect(mocks.lifecycle.resume).not.toHaveBeenCalled()
    })
  })
})
