import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { findOrganizationById, updateOrganization } from '@pagespace/lib/organizations/repository';
import { deleteOrganization } from '@pagespace/lib/organizations/deletion';
import { authorizeOrgRequest, ORG_READ_AUTH, ORG_WRITE_AUTH } from '@/lib/orgs/org-route-auth';
import { orgDeleteSchema, orgUpdateSchema } from '@/lib/orgs/org-schemas';

type Context = { params: Promise<{ orgId: string }> };

/** GET /api/orgs/[orgId] — any member. */
export async function GET(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'MEMBER', ORG_READ_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const org = await findOrganizationById(orgId);
    if (!org) return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    auditRequest(request, {
      eventType: 'data.read',
      userId: gate.userId,
      resourceType: 'organization',
      resourceId: orgId,
      details: { operation: 'read_organization' },
    });
    const { id, name, slug, avatarUrl, ownerId, createdAt } = org;
    return NextResponse.json({ organization: { id, name, slug, avatarUrl, ownerId, createdAt } });
  } catch (error) {
    loggers.api.error('Error reading organization:', error as Error);
    return NextResponse.json({ error: 'Failed to read organization' }, { status: 500 });
  }
}

/** PATCH /api/orgs/[orgId] — name, slug, avatar; Owner and Admins. */
export async function PATCH(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const parsed = orgUpdateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues }, { status: 400 });
    }
    const result = await updateOrganization(orgId, parsed.data);
    if (!result.ok) {
      return result.reason === 'slug_taken'
        ? NextResponse.json({ error: 'That organization URL is already taken' }, { status: 409 })
        : NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    }
    auditRequest(request, {
      eventType: 'data.write',
      userId: gate.userId,
      resourceType: 'organization',
      resourceId: orgId,
      details: { operation: 'update_organization', fields: Object.keys(parsed.data) },
    });
    const { id, name, slug, avatarUrl, ownerId, createdAt } = result.organization;
    return NextResponse.json({ organization: { id, name, slug, avatarUrl, ownerId, createdAt } });
  } catch (error) {
    loggers.api.error('Error updating organization:', error as Error);
    return NextResponse.json({ error: 'Failed to update organization' }, { status: 500 });
  }
}

/**
 * DELETE /api/orgs/[orgId] — Owner only (ORG-6). Body names a destination for
 * every live org drive; trashed drives go to the Owner's trash. The response and
 * one audit event per drive list where each drive went.
 */
export async function DELETE(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'OWNER', ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const parsed = orgDeleteSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues }, { status: 400 });
    }
    const result = await deleteOrganization({ orgId, choices: parsed.data.drives, now: new Date() });
    if (!result.ok) {
      return result.status === 404
        ? NextResponse.json({ error: 'Organization not found' }, { status: 404 })
        : NextResponse.json(
            { error: 'Every organization drive needs a valid destination', reason: result.reason, driveIds: result.driveIds },
            { status: 400 },
          );
    }
    for (const step of result.steps) {
      auditRequest(request, {
        eventType: 'data.write',
        userId: gate.userId,
        resourceType: 'drive',
        resourceId: step.driveId,
        details: {
          operation: 'org_delete_drive_disposition',
          orgId,
          destination: step.destination,
          newOwnerId: step.ownerId,
          trashed: step.trashed,
        },
      });
    }
    auditRequest(request, {
      eventType: 'data.delete',
      userId: gate.userId,
      resourceType: 'organization',
      resourceId: orgId,
      details: { operation: 'delete_organization', driveCount: result.steps.length },
    });
    return NextResponse.json({ deleted: true, drives: result.steps });
  } catch (error) {
    loggers.api.error('Error deleting organization:', error as Error);
    return NextResponse.json({ error: 'Failed to delete organization' }, { status: 500 });
  }
}
