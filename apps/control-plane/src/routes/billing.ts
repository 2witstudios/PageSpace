import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { validateSlug, validateEmail, validateTier } from '../validation/tenant-validation'

type StripeCheckout = {
  checkout: {
    sessions: {
      create: (params: Record<string, unknown>) => Promise<{ id: string; url: string }>
    }
  }
  billingPortal: {
    sessions: {
      create: (params: Record<string, unknown>) => Promise<{ id: string; url: string }>
    }
  }
}

type BillingRepo = {
  getTenantBySlug(slug: string): Promise<Record<string, unknown> | null>
}

export type BillingRouteDeps = {
  stripe: StripeCheckout
  repo: BillingRepo
}

export async function billingRoutes(app: FastifyInstance, deps: BillingRouteDeps) {
  const { stripe, repo } = deps

  // POST /api/billing/checkout — create Stripe checkout session
  app.post('/api/billing/checkout', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, string> | undefined
    if (!body) return reply.status(400).send({ error: 'Request body is required' })

    const { slug, email, tier } = body

    const errors: string[] = []
    if (typeof slug !== 'string' || slug.length === 0) errors.push('slug is required')
    if (typeof email !== 'string' || email.length === 0) errors.push('email is required')
    if (typeof tier !== 'string' || tier.length === 0) errors.push('tier is required')

    if (errors.length > 0) {
      return reply.status(400).send({ error: errors.join(', ') })
    }

    const slugResult = validateSlug(slug)
    if (!slugResult.valid) return reply.status(400).send({ error: slugResult.error })

    const emailResult = validateEmail(email)
    if (!emailResult.valid) return reply.status(400).send({ error: emailResult.error })

    const tierResult = validateTier(tier)
    if (!tierResult.valid) return reply.status(400).send({ error: tierResult.error })

    // Check slug not already taken
    const existing = await repo.getTenantBySlug(slug)
    if (existing) {
      return reply.status(409).send({ error: `Tenant slug "${slug}" is already taken` })
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email,
      metadata: { slug, tier },
      success_url: `https://${slug}.pagespace.ai`,
      cancel_url: 'https://pagespace.ai',
      line_items: [
        {
          price: `price_${tier}`,
          quantity: 1,
        },
      ],
    })

    return reply.send({ sessionId: session.id, url: session.url })
  })

  // POST /api/billing/portal — create Stripe billing portal session
  app.post('/api/billing/portal', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, string> | undefined
    if (!body) return reply.status(400).send({ error: 'Request body is required' })

    const { tenantSlug } = body

    if (typeof tenantSlug !== 'string' || tenantSlug.length === 0) {
      return reply.status(400).send({ error: 'tenantSlug is required' })
    }

    const tenant = await repo.getTenantBySlug(tenantSlug)
    if (!tenant) {
      return reply.status(404).send({ error: `Tenant "${tenantSlug}" not found` })
    }

    if (!tenant.stripeCustomerId) {
      return reply.status(400).send({ error: 'Tenant has no Stripe customer ID' })
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: tenant.stripeCustomerId as string,
      return_url: `https://${tenantSlug}.pagespace.ai`,
    })

    return reply.send({ url: session.url })
  })
}
