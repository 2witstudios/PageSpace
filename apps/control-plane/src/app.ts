import Fastify from 'fastify'
import { healthRoute } from './routes/health'

export function createApp({ logger = false }: { logger?: boolean } = {}) {
  const app = Fastify({ logger })

  app.register(healthRoute)

  return app
}
