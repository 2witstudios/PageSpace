import { authorizeOrgRequest, ORG_READ_AUTH } from '@/lib/orgs/org-route-auth';
import { serveAvatarFile } from '@/lib/avatars/avatar-route';

/**
 * GET /api/orgs/[orgId]/avatar/[filename] — the org's avatar image (ORG-1), for its members only:
 * whether an org exists is org data, so an outsider gets the same 404 as for any org route.
 */
export async function GET(request: Request, context: { params: Promise<{ orgId: string; filename: string }> }) {
  const { orgId, filename } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'MEMBER', ORG_READ_AUTH);
  if (!gate.ok) return gate.response;
  return serveAvatarFile('org', orgId, filename);
}
