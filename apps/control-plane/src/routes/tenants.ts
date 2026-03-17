import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { validateSlug, validateEmail, validateTier } from '../validation/tenant-validation'

type TenantRouteDeps = {
  repo: any
  provisioningEngine: any
  lifecycle: any
}

function classifyError(error: Error): { status: number; error: string } {
  const msg = error.message
  if (msg.includes('not found')) return { status: 404, error: msg }
  if (msg.includes('Cannot transition') || msg.includes('conflict') || msg.includes('already exists')) {
    return { status: 409, error: msg }
  }
  return { status: 500, error: msg }
}

export async function tenantRoutes(app: FastifyInstance, deps: TenantRouteDeps) {
  const { repo, provisioningEngine, lifecycle } = deps

  // POST /api/tenants — create + trigger async provisioning
  app.post('/api/tenants', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, string> | undefined
    if (!body) return reply.status(400).send({ error: 'Request body is required' })

    const { slug, name, ownerEmail, tier } = body

    // Validate all fields
    const errors: string[] = []
    if (!slug) errors.push('slug is required')
    if (!name) errors.push('name is required')
    if (!ownerEmail) errors.push('ownerEmail is required')
    if (!tier) errors.push('tier is required')

    if (errors.length > 0) {
      return reply.status(400).send({ error: errors.join(', ') })
    }

    const slugResult = validateSlug(slug)
    if (!slugResult.valid) return reply.status(400).send({ error: slugResult.error })

    const emailResult = validateEmail(ownerEmail)
    if (!emailResult.valid) return reply.status(400).send({ error: emailResult.error })

    const tierResult = validateTier(tier)
    if (!tierResult.valid) return reply.status(400).send({ error: tierResult.error })

    // Check for duplicate slug
    const existing = await repo.getTenantBySlug(slug)
    if (existing) {
      return reply.status(409).send({ error: `Tenant slug "${slug}" already exists` })
    }

    // Create the tenant record
    const tenant = await repo.createTenant({ slug, name, ownerEmail, tier })

    // Fire-and-forget provisioning
    provisioningEngine.provision({ slug, ownerEmail, tier }).catch(() => {
      // Provisioning errors are recorded by the engine itself
    })

    return reply.status(202).send(tenant)
  })

  // GET /api/tenants — list
  app.get('/api/tenants', async (request: FastifyRequest, reply: FastifyReply) => {
    const { searchParams } = new URL(request.url, 'http://localhost')
    const status = searchParams.get('status') ?? undefined

    const tenantList = await repo.listTenants({ status })
    return reply.send({ tenants: tenantList })
  })

  // GET /api/tenants/:slug — detail with recent events
  app.get('/api/tenants/:slug', async (request: FastifyRequest, reply: FastifyReply) => {
    const { slug } = request.params as { slug: string }

    const tenant = await repo.getTenantBySlug(slug)
    if (!tenant) return reply.status(404).send({ error: `Tenant "${slug}" not found` })

    const recentEvents = await repo.getRecentEvents(tenant.id, 20)
    return reply.send({ ...tenant, recentEvents })
  })

  // POST /api/tenants/:slug/suspend
  app.post('/api/tenants/:slug/suspend', async (request: FastifyRequest, reply: FastifyReply) => {
    const { slug } = request.params as { slug: string }

    try {
      await lifecycle.suspend(slug)
      const tenant = await repo.getTenantBySlug(slug)
      return reply.send(tenant)
    } catch (error) {
      const classified = classifyError(error as Error)
      return reply.status(classified.status).send({ error: classified.error })
    }
  })

  // POST /api/tenants/:slug/resume
  app.post('/api/tenants/:slug/resume', async (request: FastifyRequest, reply: FastifyReply) => {
    const { slug } = request.params as { slug: string }

    try {
      await lifecycle.resume(slug)
      const tenant = await repo.getTenantBySlug(slug)
      return reply.send(tenant)
    } catch (error) {
      const classified = classifyError(error as Error)
      return reply.status(classified.status).send({ error: classified.error })
    }
  })

  // POST /api/tenants/:slug/upgrade
  app.post('/api/tenants/:slug/upgrade', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, string> | undefined
    const imageTag = body?.imageTag

    if (!imageTag) {
      return reply.status(400).send({ error: 'imageTag is required' })
    }

    const { slug } = request.params as { slug: string }

    try {
      await lifecycle.upgrade(slug, imageTag)
      const tenant = await repo.getTenantBySlug(slug)
      return reply.send(tenant)
    } catch (error) {
      const classified = classifyError(error as Error)
      return reply.status(classified.status).send({ error: classified.error })
    }
  })

  // DELETE /api/tenants/:slug
  app.delete('/api/tenants/:slug', async (request: FastifyRequest, reply: FastifyReply) => {
    const { slug } = request.params as { slug: string }

    try {
      await lifecycle.destroy(slug)
      return reply.status(202).send({ message: `Destruction of "${slug}" initiated` })
    } catch (error) {
      const classified = classifyError(error as Error)
      return reply.status(classified.status).send({ error: classified.error })
    }
  })
}
