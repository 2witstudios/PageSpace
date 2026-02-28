import { db, eq, organizations } from '@pagespace/db';
import { withOrgAdminAuth, type OrgRouteContext } from '@/lib/orgs/org-auth';
import { stripe } from '@/lib/stripe';

// GET /api/orgs/[orgId]/billing/invoices - List org invoices
export const GET = withOrgAdminAuth<OrgRouteContext>(async (_user, request, _context, orgId) => {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '10'), 100);
  const startingAfter = searchParams.get('starting_after') ?? undefined;

  const [org] = await db
    .select({ stripeCustomerId: organizations.stripeCustomerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org?.stripeCustomerId) {
    return Response.json({ invoices: [], hasMore: false });
  }

  const invoices = await stripe.invoices.list({
    customer: org.stripeCustomerId,
    limit,
    starting_after: startingAfter,
  });

  const mapped = invoices.data.map((inv) => ({
    id: inv.id,
    number: inv.number,
    status: inv.status,
    amountDue: inv.amount_due,
    amountPaid: inv.amount_paid,
    currency: inv.currency,
    created: inv.created ? new Date(inv.created * 1000).toISOString() : null,
    periodStart: inv.period_start ? new Date(inv.period_start * 1000).toISOString() : null,
    periodEnd: inv.period_end ? new Date(inv.period_end * 1000).toISOString() : null,
    hostedInvoiceUrl: inv.hosted_invoice_url,
    pdfUrl: inv.invoice_pdf,
  }));

  return Response.json({
    invoices: mapped,
    hasMore: invoices.has_more,
  });
});
