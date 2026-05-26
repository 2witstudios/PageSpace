import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { z } from 'zod/v4';
import { rolePermissionService } from '@/services/api';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

export async function GET(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  const { pageId } = await params;

  const roles = await rolePermissionService.getPageRoleGrants(pageId);
  return NextResponse.json({ roles });
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

  return NextResponse.json({ success: true });
}

const deleteSchema = z.object({
  roleId: z.string(),
});

export async function DELETE(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  const { pageId } = await params;

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

  return NextResponse.json({ success: true });
}
