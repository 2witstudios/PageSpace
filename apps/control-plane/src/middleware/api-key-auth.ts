import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import { timingSafeEqual } from 'node:crypto'

function safeCompare(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a)
  const bBuffer = Buffer.from(b)
  if (aBuffer.length !== bBuffer.length) return false
  return timingSafeEqual(aBuffer, bBuffer)
}

async function apiKeyAuthPlugin(app: FastifyInstance) {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url === '/api/health') return

    const apiKey = process.env.CONTROL_PLANE_API_KEY
    if (!apiKey) {
      request.log.warn('CONTROL_PLANE_API_KEY not configured')
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    const provided = request.headers['x-api-key'] as string | undefined
    if (!provided || !safeCompare(provided, apiKey)) {
      request.log.warn({ ip: request.ip }, 'auth failure: invalid API key')
      return reply.status(401).send({ error: 'Unauthorized' })
    }
  })
}

export const apiKeyAuth = fp(apiKeyAuthPlugin, { name: 'api-key-auth' })
