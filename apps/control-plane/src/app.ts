import Fastify from 'fastify'
import { healthRoute, tenantRoutes } from './routes'
import { apiKeyAuth } from './middleware/api-key-auth'

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
