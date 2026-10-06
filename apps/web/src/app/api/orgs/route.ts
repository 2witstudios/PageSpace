import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { createOrganization, listOrganizationsForUser } from '@pagespace/lib/organizations/repository';
import { isOrgActive } from '@pagespace/lib/organizations/status';
import {
  authenticateOrgRequest,
  refuseDriveScopedToken,
  ORG_TOKEN_READ_AUTH,
  ORG_WRITE_AUTH,
} from '@/lib/orgs/org-route-auth';
import { orgCreateSchema } from '@/lib/orgs/org-schemas';
import { startOrgBusinessSubscription } from '@/lib/org-billing/org-subscription';

/**
 * GET /api/orgs — the orgs the caller belongs to, with their role (ORG-2) and whether each is lapsed: the drive-side
 * screens disable what a lapsed org may not loosen ([D-OW-33]). Every member already sees that the org is read-only
 * while lapsed (SEAT-6), so the flag tells them nothing new. Session or MCP token (X-1); a drive-scoped token is
 * refused, since the list is wider than any drive scope.
 */
export async function GET(request: Request) {
  const gate = await authenticateOrgRequest(request, ORG_TOKEN_READ_AUTH);
  if (!gate.ok) return gate.response;
  const scoped = refuseDriveScopedToken(gate);
  if (scoped) return scoped;
  try {
    const organizations = await Promise.all(
      (await listOrganizationsForUser(gate.userId)).map(async (org) => ({ ...org, lapsed: !(await isOrgActive(org.id)) })),
    );
    auditRequest(request, {
      eventType: 'data.read',
      userId: gate.userId,
      resourceType: 'organization',
      resourceId: 'self',
      details: { operation: 'list_organizations', count: organizations.length },
    });
    return NextResponse.json({ organizations });
  } catch (error) {
    loggers.api.error('Error listing organizations:', error as Error);
    return NextResponse.json({ error: 'Failed to list organizations', code: 'internal_error' }, { status: 500 });
  }
}

/**
 * POST /api/orgs — create an org; the caller becomes its Owner (ORG-1) and the org
 * starts Business with NO trial ([D-OW-30]): `billing.state` is `payment_required` with
 * the client secret the client confirms a card with, and the org spends nothing until
 * that first payment lands. The org is created even when Stripe cannot be reached:
 * `billing.state` is then `pending` and POST /api/orgs/[orgId]/billing/subscription
 * provisions it.
 */
export async function POST(request: Request) {
  const gate = await authenticateOrgRequest(request, ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const parsed = orgCreateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues, code: 'invalid_request' }, { status: 400 });
    }
    const result = await createOrganization({ ...parsed.data, ownerId: gate.userId });
    if (!result.ok) {
      if (result.reason === 'slug_taken') {
        return NextResponse.json({ error: 'That organization URL is already taken', code: 'slug_taken' }, { status: 409 });
      }
      return result.reason === 'owner_not_found'
        ? NextResponse.json({ error: 'Account not found', code: result.reason }, { status: 404 })
        : NextResponse.json({ error: 'Only a person can own an organization', code: result.reason }, { status: 403 });
    }
    auditRequest(request, {
      eventType: 'data.write',
      userId: gate.userId,
      resourceType: 'organization',
      resourceId: result.organization.id,
      details: { operation: 'create_organization' },
    });
    const billing = await startOrgBusinessSubscription(result.organization.id);
    const { id, name, slug, avatarUrl, ownerId, createdAt } = result.organization;
    return NextResponse.json({ organization: { id, name, slug, avatarUrl, ownerId, createdAt }, billing }, { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating organization:', error as Error);
    return NextResponse.json({ error: 'Failed to create organization', code: 'internal_error' }, { status: 500 });
  }
}
