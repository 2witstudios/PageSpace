import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'

type StripeWebhookDeps = {
  stripe: {
    webhooks: {
      constructEvent: (body: string, signature: string, secret: string) => unknown
    }
  }
  repo: {
    getTenantByStripeSubscription(subscriptionId: string): Promise<Record<string, unknown> | null>
    recordEvent(tenantId: string, eventType: string, metadata?: unknown): Promise<void>
  }
  provisioningEngine: {
    provision(request: { slug: string; name?: string; ownerEmail: string; tier: string }): Promise<unknown>
  }
  lifecycle: {
    suspend(slug: string): Promise<void>
    resume(slug: string): Promise<void>
  }
}

type CheckoutSession = {
  customer: string
  subscription: string
  customer_email: string
  metadata: { slug: string; tier: string }
}

type Subscription = {
  id: string
  customer: string
  status?: string
}

type Invoice = {
  subscription: string
  attempt_count: number
}

type StripeEvent = {
  type: string
  data: { object: unknown }
}

export async function stripeWebhookRoute(app: FastifyInstance, deps: StripeWebhookDeps) {
  const { stripe, repo, provisioningEngine, lifecycle } = deps

  // Override the default JSON parser to keep the raw body for Stripe signature verification
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body)
  })

  app.post('/api/webhooks/stripe', async (request: FastifyRequest, reply: FastifyReply) => {
    const signature = request.headers['stripe-signature'] as string | undefined
    if (!signature) {
      return reply.status(400).send({ error: 'Missing stripe-signature header' })
    }

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
    if (!webhookSecret) {
      request.log.error('STRIPE_WEBHOOK_SECRET not configured')
      return reply.status(500).send({ error: 'Webhook secret not configured' })
    }

    let event: StripeEvent
    try {
      event = stripe.webhooks.constructEvent(
        request.body as string,
        signature,
        webhookSecret
      ) as StripeEvent
    } catch {
      return reply.status(400).send({ error: 'Invalid webhook signature' })
    }

    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object as CheckoutSession)
        break
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Subscription)
        break
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object as Invoice)
        break
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object as Subscription)
        break
      default:
        // Unknown event — acknowledge and ignore
        break
    }

    return reply.status(200).send({ received: true })
  })

  async function handleCheckoutCompleted(session: CheckoutSession) {
    const { slug, tier } = session.metadata
    const email = session.customer_email

    if (!slug || !email) return

    provisioningEngine.provision({
      slug,
      name: slug,
      ownerEmail: email,
      tier: tier || 'pro',
    }).catch(() => {
      // Provisioning errors are recorded by the engine itself
    })
  }

  async function handleSubscriptionDeleted(subscription: Subscription) {
    const tenant = await repo.getTenantByStripeSubscription(subscription.id)
    if (!tenant) return

    await lifecycle.suspend(tenant.slug as string)
  }

  async function handlePaymentFailed(invoice: Invoice) {
    const tenant = await repo.getTenantByStripeSubscription(invoice.subscription)
    if (!tenant) return

    if (invoice.attempt_count >= 3) {
      await lifecycle.suspend(tenant.slug as string)
    } else {
      await repo.recordEvent(tenant.id as string, 'payment_failed', {
        attemptCount: invoice.attempt_count,
      })
    }
  }

  async function handleSubscriptionUpdated(subscription: Subscription) {
    if (subscription.status !== 'active') return

    const tenant = await repo.getTenantByStripeSubscription(subscription.id)
    if (!tenant) return

    if (tenant.status === 'suspended') {
      await lifecycle.resume(tenant.slug as string)
    }
  }
}
