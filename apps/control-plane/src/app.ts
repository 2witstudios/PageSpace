import Fastify from 'fastify'
import { healthRoute, tenantRoutes } from './routes'
import { apiKeyAuth } from './middleware/api-key-auth'
import type { TenantRouteDeps } from './routes/tenants'

export type AppDeps = {
  logger?: boolean
} & Partial<TenantRouteDeps>

export function createApp({ logger = false, repo, provisioningEngine, lifecycle }: AppDeps = {}) {
  const app = Fastify({ logger })

  app.register(apiKeyAuth)
  app.register(healthRoute)

  if (repo && provisioningEngine && lifecycle) {
    app.register(tenantRoutes, { repo, provisioningEngine, lifecycle })
  }

  return app
}
