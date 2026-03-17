import Fastify from 'fastify'
import { healthRoute, tenantRoutes, stripeWebhookRoute, billingRoutes } from './routes'
import { apiKeyAuth } from './middleware/api-key-auth'
import type { TenantRouteDeps } from './routes/tenants'

type StripeClient = {
  webhooks: {
    constructEvent: (body: string, signature: string, secret: string) => unknown
  }
  checkout?: {
    sessions: {
      create: (params: Record<string, unknown>) => Promise<{ id: string; url: string | null }>
    }
  }
  billingPortal?: {
    sessions: {
      create: (params: Record<string, unknown>) => Promise<{ id: string; url: string }>
    }
  }
}

type WebhookRepo = {
  getTenantByStripeSubscription(subscriptionId: string): Promise<Record<string, unknown> | null>
  recordEvent(tenantId: string, eventType: string, metadata?: unknown): Promise<void>
  updateTenantStripeIds(id: string, stripeCustomerId: string, stripeSubscriptionId: string): Promise<unknown>
}

export type AppDeps = {
  logger?: boolean
  stripe?: StripeClient
  priceMap?: Record<string, string>
  repo?: TenantRouteDeps['repo'] & Partial<WebhookRepo>
  provisioningEngine?: TenantRouteDeps['provisioningEngine']
  lifecycle?: TenantRouteDeps['lifecycle']
}

export function createApp({ logger = false, repo, provisioningEngine, lifecycle, stripe, priceMap }: AppDeps = {}) {
  const app = Fastify({ logger })

  app.register(apiKeyAuth)
  app.register(healthRoute)

  if (repo && provisioningEngine && lifecycle) {
    app.register(tenantRoutes, { repo, provisioningEngine, lifecycle })

    if (stripe && repo.getTenantByStripeSubscription && repo.recordEvent && repo.updateTenantStripeIds) {
      const webhookRepo = repo as TenantRouteDeps['repo'] & WebhookRepo
      app.register(stripeWebhookRoute, { stripe, repo: webhookRepo, provisioningEngine, lifecycle })

      if (stripe.checkout && stripe.billingPortal) {
        app.register(billingRoutes, {
          stripe: stripe as Required<Pick<StripeClient, 'checkout' | 'billingPortal'>>,
          repo,
          priceMap: priceMap ?? {},
        })
      }
    }
  }

  return app
}
