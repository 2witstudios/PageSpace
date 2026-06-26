import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  authenticateRequestWithOptions,
  isAuthError,
  checkMCPDriveScope,
  isPrincipalDriveOwnerOrAdmin,
} from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@/lib/audit/audit-log';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { getPlan } from '@/lib/subscription/plans';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { changePublishSubdomain, PublishError } from '@/lib/canvas/publish-page';

const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true }; // keep PATCH CSRF-protected

const schema = z.object({
  subdomain: z.string().min(1).max(63),
});

async function canChooseSubdomain(driveId: string): Promise<boolean> {
  const [row] = await db
    .select({ tier: users.subscriptionTier })
    .from(drives)
    .innerJoin(users, eq(drives.ownerId, users.id))
    .where(eq(drives.id, driveId))
    .limit(1);
  const tier = ((row?.tier ?? 'free') as SubscriptionTier);
  return getPlan(tier).limits.canChooseSubdomain;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const { driveId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, { allow: ['session', 'mcp'] as const, requireCSRF: false });
    if (isAuthError(auth)) return auth.error;

    const scopeError = checkMCPDriveScope(auth, driveId);
    if (scopeError) return scopeError;

    if (!(await isPrincipalDriveOwnerOrAdmin(auth, driveId))) {
      return NextResponse.json({ error: 'Only drive owners and admins can view subdomain settings' }, { status: 403 });
    }

    const [driveRow] = await db
      .select({ publishSubdomain: drives.publishSubdomain })
      .from(drives)
      .where(eq(drives.id, driveId))
      .limit(1);

    const canChange = await canChooseSubdomain(driveId);

    return NextResponse.json({
      subdomain: driveRow?.publishSubdomain ?? null,
      canChange,
    });
  } catch (error) {
    loggers.api.error('Error reading subdomain:', error as Error);
    return NextResponse.json({ error: 'Failed to read subdomain' }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const { driveId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;

    const scopeError = checkMCPDriveScope(auth, driveId);
    if (scopeError) return scopeError;

    const userId = auth.userId!;

    if (!(await isPrincipalDriveOwnerOrAdmin(auth, driveId))) {
      return NextResponse.json({ error: 'Only drive owners and admins can change the subdomain' }, { status: 403 });
    }

    if (!(await canChooseSubdomain(driveId))) {
      return NextResponse.json(
        { error: 'Custom subdomain selection is a Pro feature. Upgrade to choose your own subdomain.' },
        { status: 403 }
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid subdomain' }, { status: 400 });
    }

    const result = await changePublishSubdomain(driveId, parsed.data.subdomain, userId);

    auditRequest(request, {
      eventType: 'data.write',
      userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: {
        operation: 'change_publish_subdomain',
        oldSubdomain: result.oldSubdomain,
        newSubdomain: result.newSubdomain,
      },
    });

    return NextResponse.json({
      subdomain: result.newSubdomain,
      url: `https://${result.newSubdomain}.pagespace.site`,
    });
  } catch (error) {
    loggers.api.error('Error changing subdomain:', error as Error);
    if (error instanceof PublishError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    return NextResponse.json({ error: 'Failed to change subdomain' }, { status: 500 });
  }
}
