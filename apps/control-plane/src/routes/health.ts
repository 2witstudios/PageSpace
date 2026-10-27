import { FastifyInstance } from 'fastify'
import { version } from '../../package.json'

export async function healthRoute(app: FastifyInstance) {
  app.get('/api/health', async () => {
    return {
      status: 'ok',
      service: 'control-plane',
      version,
    }
  })
}
