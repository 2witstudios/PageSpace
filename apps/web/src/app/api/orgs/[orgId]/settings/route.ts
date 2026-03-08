import { db, eq, organizations } from '@pagespace/db';
import { withOrgAdminAuth, type OrgRouteContext } from '@/lib/orgs/org-auth';

// GET /api/orgs/[orgId]/settings - Get org guardrail settings
export const GET = withOrgAdminAuth<OrgRouteContext>(async (_user, _request, _context, orgId) => {
  const [org] = await db
    .select({
      allowedAIProviders: organizations.allowedAIProviders,
      maxStorageBytes: organizations.maxStorageBytes,
      maxAITokensPerDay: organizations.maxAITokensPerDay,
      requireMFA: organizations.requireMFA,
      allowExternalSharing: organizations.allowExternalSharing,
      allowedDomains: organizations.allowedDomains,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org) {
    return Response.json({ error: 'Organization not found' }, { status: 404 });
  }

  return Response.json(org);
});

// PUT /api/orgs/[orgId]/settings - Update org guardrail settings
export const PUT = withOrgAdminAuth<OrgRouteContext>(async (_user, request, _context, orgId) => {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};

  if ('allowedAIProviders' in body) {
    if (body.allowedAIProviders !== null && !Array.isArray(body.allowedAIProviders)) {
      return Response.json({ error: 'allowedAIProviders must be an array or null' }, { status: 400 });
    }
    updates.allowedAIProviders = body.allowedAIProviders;
  }

  if ('maxStorageBytes' in body) {
    if (body.maxStorageBytes !== null && (typeof body.maxStorageBytes !== 'number' || body.maxStorageBytes < 0)) {
      return Response.json({ error: 'maxStorageBytes must be a positive number or null' }, { status: 400 });
    }
    updates.maxStorageBytes = body.maxStorageBytes;
  }

  if ('maxAITokensPerDay' in body) {
    if (body.maxAITokensPerDay !== null && (typeof body.maxAITokensPerDay !== 'number' || body.maxAITokensPerDay < 0)) {
      return Response.json({ error: 'maxAITokensPerDay must be a positive number or null' }, { status: 400 });
    }
    updates.maxAITokensPerDay = body.maxAITokensPerDay;
  }

  if ('requireMFA' in body) {
    if (typeof body.requireMFA !== 'boolean') {
      return Response.json({ error: 'requireMFA must be a boolean' }, { status: 400 });
    }
    updates.requireMFA = body.requireMFA;
  }

  if ('allowExternalSharing' in body) {
    if (typeof body.allowExternalSharing !== 'boolean') {
      return Response.json({ error: 'allowExternalSharing must be a boolean' }, { status: 400 });
    }
    updates.allowExternalSharing = body.allowExternalSharing;
  }

  if ('allowedDomains' in body) {
    if (body.allowedDomains !== null && !Array.isArray(body.allowedDomains)) {
      return Response.json({ error: 'allowedDomains must be an array or null' }, { status: 400 });
    }
    updates.allowedDomains = body.allowedDomains;
  }

  if (Object.keys(updates).length === 0) {
    return Response.json({ error: 'No valid settings to update' }, { status: 400 });
  }

  await db
    .update(organizations)
    .set(updates)
    .where(eq(organizations.id, orgId));

  const [updated] = await db
    .select({
      allowedAIProviders: organizations.allowedAIProviders,
      maxStorageBytes: organizations.maxStorageBytes,
      maxAITokensPerDay: organizations.maxAITokensPerDay,
      requireMFA: organizations.requireMFA,
      allowExternalSharing: organizations.allowExternalSharing,
      allowedDomains: organizations.allowedDomains,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  return Response.json(updated);
});
