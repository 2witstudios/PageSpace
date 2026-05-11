import { NextResponse } from 'next/server';
import { authenticateWithEnforcedContext, isEnforcedAuthError } from '@/lib/auth';
import {
  createDriveShareLink,
  listDriveShareLinks,
} from '@pagespace/lib/permissions/share-link-service';
import { z } from 'zod/v4';

const AUTH_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_WRITE = { allow: ['session'] as const, requireCSRF: true };

const CreateBodySchema = z.object({
  role: z.enum(['MEMBER', 'ADMIN']).optional(),
  expiresAt: z.string().optional(),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  const auth = await authenticateWithEnforcedContext(request, AUTH_READ);
  if (isEnforcedAuthError(auth)) return auth.error;

  const { driveId } = await context.params;

  const result = await listDriveShareLinks(auth.ctx, driveId);
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
  context: { params: Promise<{ driveId: string }> }
) {
  const auth = await authenticateWithEnforcedContext(request, AUTH_WRITE);
  if (isEnforcedAuthError(auth)) return auth.error;

  const { driveId } = await context.params;

  let role: 'MEMBER' | 'ADMIN' | undefined;
  let expiresAt: Date | undefined;
  try {
    const raw = await request.json();
    const parsed = CreateBodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    role = parsed.data.role;
    expiresAt = parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : undefined;
  } catch {
    // empty body is fine — all fields optional
  }

  const result = await createDriveShareLink(auth.ctx, driveId, { role, expiresAt });

  if (!result.ok) {
    if (result.error === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
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
