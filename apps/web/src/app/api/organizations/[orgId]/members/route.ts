import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import {
  checkOrgAccess,
  listOrgMembers,
  createInvitation,
} from '@pagespace/lib/server';
import { safeParseBody } from '@/lib/validation/parse-body';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const inviteSchema = z.object({
  email: z.string().email('Valid email required'),
  role: z.enum(['ADMIN', 'MEMBER']).default('MEMBER'),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ orgId: string }> }
) {
  const { orgId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  try {
    const access = await checkOrgAccess(orgId, auth.userId);

    if (!access.org) {
      return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    }
    if (!access.isMember) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const members = await listOrgMembers(orgId);
    return NextResponse.json({
      members,
      currentUserRole: access.role,
    });
  } catch {
    return NextResponse.json({ error: 'Failed to fetch members' }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ orgId: string }> }
) {
  const { orgId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  const parsed = await safeParseBody(request, inviteSchema);
  if (!parsed.success) return parsed.response;

  try {
    const access = await checkOrgAccess(orgId, auth.userId);

    if (!access.org) {
      return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    }
    if (!access.isOwner && !access.isAdmin) {
      return NextResponse.json({ error: 'Only owners and admins can invite members' }, { status: 403 });
    }

    const invitation = await createInvitation(orgId, auth.userId, parsed.data);
    return NextResponse.json(invitation, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create invitation';
    const status = message.includes('already') ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
