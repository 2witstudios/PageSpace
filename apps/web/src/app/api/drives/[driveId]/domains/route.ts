import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  authenticateRequestWithOptions,
  isAuthError,
  checkMCPDriveScope,
  isPrincipalDriveOwnerOrAdmin,
} from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { normalizeHostname, validateCustomDomain } from '@pagespace/lib/validators/custom-domain';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { customDomains } from '@pagespace/db/schema/custom-domains';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

const addDomainSchema = z.object({
  hostname: z.string().min(1),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string }> },
) {
  try {
    const { driveId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;

    const scopeError = checkMCPDriveScope(auth, driveId);
    if (scopeError) return scopeError;

    if (!(await isPrincipalDriveOwnerOrAdmin(auth, driveId))) {
      return NextResponse.json({ error: 'Only drive owners and admins can view custom domains' }, { status: 403 });
    }

    const domains = await db.select().from(customDomains).where(eq(customDomains.driveId, driveId));
    return NextResponse.json({ domains });
  } catch (error) {
    loggers.api.error('Error listing custom domains:', error as Error);
    return NextResponse.json({ error: 'Failed to list domains' }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ driveId: string }> },
) {
  try {
    const { driveId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;

    const scopeError = checkMCPDriveScope(auth, driveId);
    if (scopeError) return scopeError;

    if (!(await isPrincipalDriveOwnerOrAdmin(auth, driveId))) {
      return NextResponse.json({ error: 'Only drive owners and admins can add custom domains' }, { status: 403 });
    }

    const body = addDomainSchema.safeParse(await request.json());
    if (!body.success) {
      return NextResponse.json({ error: 'Invalid request body', details: body.error.issues }, { status: 400 });
    }

    const hostname = normalizeHostname(body.data.hostname);
    const validation = validateCustomDomain(hostname);
    if (!validation.valid) {
      return NextResponse.json({ error: validation.reason }, { status: 400 });
    }

    try {
      const [inserted] = await db.insert(customDomains).values({ driveId, hostname }).returning();

      auditRequest(request, {
        eventType: 'data.write',
        userId: auth.userId,
        resourceType: 'drive',
        resourceId: driveId,
        details: { operation: 'add-custom-domain', hostname },
      });

      return NextResponse.json({ domain: inserted }, { status: 201 });
    } catch (err) {
      // Unique constraint violation → duplicate hostname
      if (err instanceof Error && err.message.includes('unique')) {
        return NextResponse.json({ error: 'Domain is already registered' }, { status: 409 });
      }
      throw err;
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    loggers.api.error('Error adding custom domain:', error as Error);
    return NextResponse.json({ error: 'Failed to add domain' }, { status: 500 });
  }
}
