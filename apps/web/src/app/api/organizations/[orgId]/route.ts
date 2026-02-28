import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import {
  checkOrgAccess,
  updateOrganization,
  deleteOrganization,
  getOrganizationBySlug,
} from '@pagespace/lib/server';
import { safeParseBody } from '@/lib/validation/parse-body';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const updateOrgSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z.string().min(1).max(100)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens')
    .optional(),
  description: z.string().max(500).optional(),
  avatarUrl: z.string().url().nullable().optional(),
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

    return NextResponse.json({
      ...access.org,
      currentUserRole: access.role,
    });
  } catch {
    return NextResponse.json({ error: 'Failed to fetch organization' }, { status: 500 });
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ orgId: string }> }
) {
  const { orgId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  const parsed = await safeParseBody(request, updateOrgSchema);
  if (!parsed.success) return parsed.response;

  try {
    const access = await checkOrgAccess(orgId, auth.userId);

    if (!access.org) {
      return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    }
    if (!access.isOwner && !access.isAdmin) {
      return NextResponse.json({ error: 'Only owners and admins can update organization settings' }, { status: 403 });
    }

    // If slug is changing, check uniqueness
    if (parsed.data.slug && parsed.data.slug !== access.org.slug) {
      const existing = await getOrganizationBySlug(parsed.data.slug);
      if (existing) {
        return NextResponse.json({ error: 'An organization with this slug already exists' }, { status: 409 });
      }
    }

    const updated = await updateOrganization(orgId, parsed.data);
    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ error: 'Failed to update organization' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ orgId: string }> }
) {
  const { orgId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  try {
    const access = await checkOrgAccess(orgId, auth.userId);

    if (!access.org) {
      return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    }
    if (!access.isOwner) {
      return NextResponse.json({ error: 'Only the organization owner can delete it' }, { status: 403 });
    }

    await deleteOrganization(orgId);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Failed to delete organization' }, { status: 500 });
  }
}
