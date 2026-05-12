import { NextResponse } from 'next/server';
import { authenticateWithEnforcedContext, isEnforcedAuthError } from '@/lib/auth';
import {
  createPageShareLink,
  listPageShareLinks,
} from '@pagespace/lib/permissions/share-link-service';
import type { ShareLinkPermission } from '@pagespace/db/schema/share-links';
import { z } from 'zod/v4';

const AUTH_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_WRITE = { allow: ['session'] as const, requireCSRF: true };

const PermissionEnum = z.enum(['VIEW', 'EDIT']);

const CreateBodySchema = z.object({
  permissions: z.array(PermissionEnum).optional(),
  expiresAt: z.string().optional(),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ pageId: string }> }
) {
  const auth = await authenticateWithEnforcedContext(request, AUTH_READ);
  if (isEnforcedAuthError(auth)) return auth.error;

  const { pageId } = await context.params;

  const result = await listPageShareLinks(auth.ctx, pageId);
  if (!result.ok) {
    if (result.error === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({ links: result.data });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ pageId: string }> }
) {
  const auth = await authenticateWithEnforcedContext(request, AUTH_WRITE);
  if (isEnforcedAuthError(auth)) return auth.error;

  const { pageId } = await context.params;

  let permissions: ShareLinkPermission[] | undefined;
  let expiresAt: Date | undefined;
  try {
    const raw = await request.json();
    const parsed = CreateBodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    permissions = parsed.data.permissions as ShareLinkPermission[] | undefined;
    if (parsed.data.expiresAt) {
      const d = new Date(parsed.data.expiresAt);
      if (isNaN(d.getTime()) || d <= new Date()) {
        return NextResponse.json({ error: 'expiresAt must be a future date' }, { status: 400 });
      }
      expiresAt = d;
    }
  } catch {
    // empty body is fine — permissions defaults to ['VIEW'] in service
  }

  const result = await createPageShareLink(auth.ctx, pageId, { permissions, expiresAt });

  if (!result.ok) {
    if (result.error === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (result.error === 'INVALID_PERMISSIONS') {
      return NextResponse.json(
        { error: 'EDIT permission requires VIEW permission' },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: 'Failed to create share link' }, { status: 500 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';
  return NextResponse.json(
    {
      id: result.data.id,
      shareUrl: `${appUrl}/s/${result.data.rawToken}`,
    },
    { status: 201 }
  );
}
