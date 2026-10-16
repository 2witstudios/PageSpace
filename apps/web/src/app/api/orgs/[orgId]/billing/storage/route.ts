import { NextResponse } from 'next/server';
import { z } from 'zod';
import { announceOrgChange } from '@pagespace/lib/organizations/org-change-events';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { STORAGE_ADDON } from '@pagespace/lib/billing/subscription-tiers';
import { entitledStorageBlocks } from '@pagespace/lib/billing/storage-addon';
import type { OrgApiErrorCode } from '@pagespace/lib/organizations/api-error-codes';
import { authorizeOrgBillingRequest, ORG_READ_AUTH, ORG_MONEY_WRITE_AUTH } from '@/lib/orgs/org-route-auth';
import { getOrgStorageSummary, setOrgStorageBlocks } from '@/lib/org-billing/storage-billing';
import { classifyStorageAddonFailure } from '@/lib/stripe/storage-addon-billing';

type Context = { params: Promise<{ orgId: string }> };

const bodySchema = z.object({ blocks: z.number().int().min(0).max(STORAGE_ADDON.maxBlocks) }).strict();

const REFUSALS = {
  not_configured: { status: 503, code: 'storage_addon_unavailable', error: 'Extra storage is not available yet' },
  no_subscription: { status: 409, code: 'storage_addon_unavailable', error: 'The organization has no Business subscription' },
  lapsed: { status: 402, code: 'org_lapsed', error: 'Reactivate the organization before changing storage' },
  gifted: { status: 403, code: 'storage_addon_unavailable', error: 'Extra storage is not available on a gifted plan. Contact support.' },
  unrecognized: { status: 409, code: 'billing_requires_support', error: 'The organization subscription cannot be changed here. Contact support.' },
} as const satisfies Record<string, { status: number; code: OrgApiErrorCode; error: string }>;

/**
 * GET /api/orgs/[orgId]/billing/storage — the org's storage use and storage add-on. Owner and
 * Admins only (SEAT-6); absent where billing is off. Never a Stripe id.
 */
export async function GET(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgBillingRequest(request, orgId, 'ADMIN', ORG_READ_AUTH);
  if (!gate.ok) return gate.response;
  try {
    return NextResponse.json({ storage: await getOrgStorageSummary(orgId) });
  } catch (error) {
    loggers.api.error('Error reading organization storage:', error as Error, { orgId });
    return NextResponse.json({ error: 'Failed to read storage', code: 'internal_error' }, { status: 500 });
  }
}

/**
 * PATCH /api/orgs/[orgId]/billing/storage { blocks } — set the org's storage blocks. Owner only:
 * an increase charges the org's card now (prorated); a decrease takes effect at period end with
 * no refund.
 */
export async function PATCH(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgBillingRequest(request, orgId, 'OWNER', ORG_MONEY_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues, code: 'invalid_request' }, { status: 400 });
  }
  try {
    const outcome = await setOrgStorageBlocks(orgId, parsed.data.blocks);
    if (outcome.kind !== 'done') {
      const refusal = REFUSALS[outcome.kind];
      return NextResponse.json({ error: refusal.error, code: refusal.code }, { status: refusal.status });
    }
    const { result } = outcome;
    if (result.kind === 'invalid') {
      return NextResponse.json({ error: 'Invalid request body', code: 'invalid_request' }, { status: 400 });
    }
    if (result.kind === 'failed') {
      const failure = classifyStorageAddonFailure(result.error);
      loggers.api.warn('Org storage add-on change refused', { orgId, declined: failure.declined, error: result.error instanceof Error ? result.error.message : String(result.error) });
      return failure.declined
        ? NextResponse.json({ error: failure.message, code: 'payment_declined' }, { status: 402 })
        : NextResponse.json({ error: failure.message, code: 'billing_provider_unreachable' }, { status: 502 });
    }
    if (result.kind === 'applied') {
      auditRequest(request, {
        eventType: 'data.write',
        userId: gate.userId,
        resourceType: 'organization',
        resourceId: orgId,
        details: { operation: 'set_storage_blocks', from: outcome.before, to: result.stored.blocks, charged: result.charged },
      });
      // X-4: the Plan & seats page refetches on a seats change; storage lives on the same page.
      void announceOrgChange(orgId, 'seats');
    }
    const now = new Date();
    const entitled = entitledStorageBlocks(result.stored, now);
    return NextResponse.json({
      blocks: result.stored.blocks,
      entitledBlocks: entitled,
      graceUntil: entitled > result.stored.blocks ? result.stored.graceUntil?.toISOString() ?? null : null,
      charged: result.kind === 'applied' ? result.charged : false,
    });
  } catch (error) {
    loggers.api.error('Error changing organization storage:', error as Error, { orgId });
    return NextResponse.json({ error: 'Failed to change storage', code: 'internal_error' }, { status: 500 });
  }
}
