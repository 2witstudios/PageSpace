import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { z } from 'zod/v4';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { permissionManagementService, rolePermissionService } from '@/services/api';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

export async function GET(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  const { pageId } = await params;

  try {
    const canView = await permissionManagementService.canUserViewPermissions(auth.userId, pageId);
    if (!canView) {
      return NextResponse.json(
        { error: 'You need share permission to view role access for this page' },
        { status: 403 }
      );
    }

    const roles = await rolePermissionService.getPageRoleGrants(pageId);
    return NextResponse.json({ roles });
  } catch (error) {
    loggers.api.error('Error fetching role permissions:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch role permissions' }, { status: 500 });
  }
}

const putSchema = z.object({
  roleId: z.string(),
  canView: z.boolean().default(true),
  canEdit: z.boolean().default(false),
  canShare: z.boolean().default(false),
});

export async function PUT(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  const { pageId } = await params;

  try {
    const body = await req.json();
    const parsed = putSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }
    const { roleId, canView, canEdit, canShare } = parsed.data;

    const result = await rolePermissionService.setRolePagePermission(
      auth.userId,
      pageId,
      roleId,
      { canView, canEdit, canShare },
    );

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    auditRequest(req, {
      eventType: 'authz.permission.granted',
      userId: auth.userId,
      resourceType: 'page',
      resourceId: pageId,
      details: { roleId, canView, canEdit, canShare },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error setting role permission:', error as Error);
    return NextResponse.json({ error: 'Failed to set role permission' }, { status: 500 });
  }
}

const deleteSchema = z.object({
  roleId: z.string(),
});

export async function DELETE(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  const { pageId } = await params;

  try {
    const body = await req.json();
    const parsed = deleteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }

    const result = await rolePermissionService.removeRolePagePermission(
      auth.userId,
      pageId,
      parsed.data.roleId,
    );

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    auditRequest(req, {
      eventType: 'authz.permission.revoked',
      userId: auth.userId,
      resourceType: 'page',
      resourceId: pageId,
      details: { roleId: parsed.data.roleId },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error removing role permission:', error as Error);
    return NextResponse.json({ error: 'Failed to remove role permission' }, { status: 500 });
  }
}
