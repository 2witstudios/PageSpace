import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { createOrganization, listOrganizationsForUser } from '@pagespace/lib/organizations/repository';
import { authenticateOrgRequest, ORG_READ_AUTH, ORG_WRITE_AUTH } from '@/lib/orgs/org-route-auth';
import { orgCreateSchema } from '@/lib/orgs/org-schemas';

/** GET /api/orgs — the orgs the caller belongs to, with their role (ORG-2). */
export async function GET(request: Request) {
  const gate = await authenticateOrgRequest(request, ORG_READ_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const organizations = await listOrganizationsForUser(gate.userId);
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
    return NextResponse.json({ error: 'Failed to list organizations' }, { status: 500 });
  }
}

/** POST /api/orgs — create an org; the caller becomes its Owner (ORG-1). */
export async function POST(request: Request) {
  const gate = await authenticateOrgRequest(request, ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const parsed = orgCreateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues }, { status: 400 });
    }
    const result = await createOrganization({ ...parsed.data, ownerId: gate.userId });
    if (!result.ok) {
      return result.reason === 'slug_taken'
        ? NextResponse.json({ error: 'That organization URL is already taken' }, { status: 409 })
        : NextResponse.json({ error: 'Only a person can own an organization', reason: result.reason }, { status: 403 });
    }
    auditRequest(request, {
      eventType: 'data.write',
      userId: gate.userId,
      resourceType: 'organization',
      resourceId: result.organization.id,
      details: { operation: 'create_organization' },
    });
    const { id, name, slug, avatarUrl, ownerId, createdAt } = result.organization;
    return NextResponse.json({ organization: { id, name, slug, avatarUrl, ownerId, createdAt } }, { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating organization:', error as Error);
    return NextResponse.json({ error: 'Failed to create organization' }, { status: 500 });
  }
}
