import Fastify from 'fastify'
import { healthRoute } from './routes/health'

export function createApp() {
  const app = Fastify({ logger: false })

  app.register(healthRoute)

  return app
}
