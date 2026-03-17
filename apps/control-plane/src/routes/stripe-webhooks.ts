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
    updateTenantStripeIds(id: string, stripeCustomerId: string, stripeSubscriptionId: string): Promise<unknown>
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

    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await handleCheckoutCompleted(event.data.object as CheckoutSession, request)
          break
        case 'customer.subscription.deleted':
          await handleSubscriptionDeleted(event.data.object as Subscription, request)
          break
        case 'invoice.payment_failed':
          await handlePaymentFailed(event.data.object as Invoice, request)
          break
        case 'customer.subscription.updated':
          await handleSubscriptionUpdated(event.data.object as Subscription, request)
          break
        default:
          break
      }
    } catch (error) {
      request.log.error({ err: error, eventType: event.type }, 'webhook handler failed')
      return reply.status(500).send({ error: 'Webhook processing failed' })
    }

    return reply.status(200).send({ received: true })
  })

  async function handleCheckoutCompleted(session: CheckoutSession, request: FastifyRequest) {
    const { slug, tier } = session.metadata
    const email = session.customer_email

    if (!slug || !email) {
      request.log.warn({ metadata: session.metadata }, 'checkout missing slug or email')
      return
    }

    const result = await provisioningEngine.provision({
      slug,
      name: slug,
      ownerEmail: email,
      tier: tier || 'pro',
    }) as { tenantId: string }

    await repo.updateTenantStripeIds(
      result.tenantId,
      session.customer,
      session.subscription,
    )

    request.log.info({ slug, tenantId: result.tenantId }, 'tenant provisioned via checkout')
  }

  async function handleSubscriptionDeleted(subscription: Subscription, request: FastifyRequest) {
    const tenant = await repo.getTenantByStripeSubscription(subscription.id)
    if (!tenant) return

    if (tenant.status === 'suspended' || tenant.status === 'destroyed') {
      request.log.info({ slug: tenant.slug }, 'subscription.deleted: already suspended/destroyed, skipping')
      return
    }

    await lifecycle.suspend(tenant.slug as string)
    request.log.info({ slug: tenant.slug }, 'tenant suspended via subscription deletion')
  }

  async function handlePaymentFailed(invoice: Invoice, request: FastifyRequest) {
    const tenant = await repo.getTenantByStripeSubscription(invoice.subscription)
    if (!tenant) return

    if (invoice.attempt_count >= 3) {
      if (tenant.status === 'suspended') {
        request.log.info({ slug: tenant.slug }, 'payment_failed: already suspended, skipping')
        return
      }
      await lifecycle.suspend(tenant.slug as string)
      request.log.info({ slug: tenant.slug, attemptCount: invoice.attempt_count }, 'tenant suspended via payment failure')
    } else {
      await repo.recordEvent(tenant.id as string, 'payment_failed', {
        attemptCount: invoice.attempt_count,
      })
      request.log.info({ slug: tenant.slug, attemptCount: invoice.attempt_count }, 'payment failure recorded')
    }
  }

  async function handleSubscriptionUpdated(subscription: Subscription, request: FastifyRequest) {
    if (subscription.status !== 'active') return

    const tenant = await repo.getTenantByStripeSubscription(subscription.id)
    if (!tenant) return

    if (tenant.status === 'suspended') {
      await lifecycle.resume(tenant.slug as string)
      request.log.info({ slug: tenant.slug }, 'tenant resumed via subscription recovery')
    }
  }
}
