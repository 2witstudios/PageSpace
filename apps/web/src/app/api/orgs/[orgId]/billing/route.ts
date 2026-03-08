import { db, eq, organizations, orgSubscriptions } from '@pagespace/db';
import { withOrgAdminAuth, withOrgOwnerAuth, type OrgRouteContext } from '@/lib/orgs/org-auth';
import { getOrgBillingOverview } from '@/lib/orgs/seat-manager';
import { stripe, type Stripe } from '@/lib/stripe';
import { getOrgMemberCount } from '@/lib/orgs/guardrails';

// GET /api/orgs/[orgId]/billing - Get billing overview
export const GET = withOrgAdminAuth<OrgRouteContext>(async (_user, _request, _context, orgId) => {
  const overview = await getOrgBillingOverview(orgId);
  if (!overview) {
    return Response.json({ error: 'Organization not found' }, { status: 404 });
  }

  return Response.json(overview);
});

// POST /api/orgs/[orgId]/billing - Create or update subscription
export const POST = withOrgOwnerAuth<OrgRouteContext>(async (user, request, _context, orgId) => {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { priceId } = body as { priceId?: string };

  if (!priceId) {
    return Response.json({ error: 'priceId is required' }, { status: 400 });
  }

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org) {
    return Response.json({ error: 'Organization not found' }, { status: 404 });
  }

  const memberCount = await getOrgMemberCount(orgId);
  let customerId = org.stripeCustomerId;

  // Create Stripe customer for org if needed
  if (!customerId) {
    const customer = await stripe.customers.create({
      name: org.name,
      email: org.billingEmail ?? undefined,
      metadata: { orgId, type: 'organization' },
    });
    customerId = customer.id;

    await db
      .update(organizations)
      .set({ stripeCustomerId: customerId })
      .where(eq(organizations.id, orgId));
  }

  // Create subscription with per-seat quantity
  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    items: [{
      price: priceId,
      quantity: Math.max(memberCount, 1),
    }],
    payment_behavior: 'default_incomplete',
    payment_settings: { save_default_payment_method: 'on_subscription' },
    metadata: { orgId, type: 'organization' },
    expand: ['latest_invoice.confirmation_secret'],
  });

  // Get the period from subscription items (Stripe API 2025+ pattern)
  const subscriptionItem = subscription.items.data[0];
  const currentPeriodStart = subscriptionItem?.current_period_start
    ? new Date(subscriptionItem.current_period_start * 1000)
    : new Date();
  const currentPeriodEnd = subscriptionItem?.current_period_end
    ? new Date(subscriptionItem.current_period_end * 1000)
    : new Date();

  await db.insert(orgSubscriptions).values({
    orgId,
    stripeSubscriptionId: subscription.id,
    stripePriceId: priceId,
    status: subscription.status,
    quantity: Math.max(memberCount, 1),
    currentPeriodStart,
    currentPeriodEnd,
  });

  const invoice = subscription.latest_invoice as Stripe.Invoice & {
    confirmation_secret?: { client_secret: string; type: string };
  };

  const clientSecret = invoice?.confirmation_secret?.client_secret ?? null;

  return Response.json({
    subscriptionId: subscription.id,
    clientSecret,
    status: subscription.status,
  }, { status: 201 });
});
