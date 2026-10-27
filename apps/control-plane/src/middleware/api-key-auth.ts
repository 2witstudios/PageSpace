import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import { secureCompare } from '@pagespace/lib/auth/secure-compare'

async function apiKeyAuthPlugin(app: FastifyInstance) {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url === '/api/health') return
    if (request.url === '/api/webhooks/stripe') return

    const apiKey = process.env.CONTROL_PLANE_API_KEY
    if (!apiKey) {
      request.log.warn('CONTROL_PLANE_API_KEY not configured')
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const provided = request.headers['x-api-key'] as string | undefined
    if (!provided || !secureCompare(provided, apiKey)) {
      request.log.warn({ ip: request.ip }, 'auth failure: invalid API key')
      return reply.status(401).send({ error: 'Unauthorized' })
    }
  })
}

export const apiKeyAuth = fp(apiKeyAuthPlugin, { name: 'api-key-auth' })
