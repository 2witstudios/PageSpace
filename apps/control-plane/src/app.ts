import Fastify from 'fastify'
import { healthRoute } from './routes/health'
import { apiKeyAuth } from './middleware/api-key-auth'
import { tenantRoutes } from './routes/tenants'

export type AppDeps = {
  logger?: boolean
  repo?: any
  provisioningEngine?: any
  lifecycle?: any
}

export function createApp({ logger = false, repo, provisioningEngine, lifecycle }: AppDeps = {}) {
  const app = Fastify({ logger })

  app.register(apiKeyAuth)
  app.register(healthRoute)

  if (repo) {
    app.register(tenantRoutes, { repo, provisioningEngine, lifecycle })
  }

  return app
}
