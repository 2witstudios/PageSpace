import Fastify from 'fastify'
import { healthRoute, tenantRoutes, stripeWebhookRoute } from './routes'
import { apiKeyAuth } from './middleware/api-key-auth'
import type { TenantRouteDeps } from './routes/tenants'

type StripeClient = {
  webhooks: {
    constructEvent: (body: string, signature: string, secret: string) => unknown
  }
}

export type AppDeps = {
  logger?: boolean
  stripe?: StripeClient
} & Partial<TenantRouteDeps>

export function createApp({ logger = false, repo, provisioningEngine, lifecycle, stripe }: AppDeps = {}) {
  const app = Fastify({ logger })

  app.register(apiKeyAuth)
  app.register(healthRoute)

  if (repo && provisioningEngine && lifecycle) {
    app.register(tenantRoutes, { repo, provisioningEngine, lifecycle })

    if (stripe) {
      app.register(stripeWebhookRoute, { stripe, repo, provisioningEngine, lifecycle })
    }
  }

  return app
}
