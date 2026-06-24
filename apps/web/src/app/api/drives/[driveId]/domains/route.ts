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
import { eq, count } from '@pagespace/db/operators';
import { customDomains } from '@pagespace/db/schema/custom-domains';
import { drives } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { getPlan } from '@/lib/subscription/plans';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

const addDomainSchema = z.object({
  hostname: z.string().min(1),
});

/** Resolve the maximum custom domains allowed for the drive owner's tier. */
async function getMaxCustomDomainsForDrive(driveId: string): Promise<number> {
  const [row] = await db
    .select({ tier: users.subscriptionTier })
    .from(drives)
    .innerJoin(users, eq(drives.ownerId, users.id))
    .where(eq(drives.id, driveId))
    .limit(1);

  const tier = ((row?.tier ?? 'free') as SubscriptionTier);
  return getPlan(tier).limits.maxCustomDomains;
}

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

    const [domains, limit] = await Promise.all([
      db.select().from(customDomains).where(eq(customDomains.driveId, driveId)),
      getMaxCustomDomainsForDrive(driveId),
    ]);

    return NextResponse.json({ domains, limit });
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

    let requestBody: unknown;
    try {
      requestBody = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const body = addDomainSchema.safeParse(requestBody);
    if (!body.success) {
      return NextResponse.json({ error: 'Invalid request body', details: body.error.issues }, { status: 400 });
    }

    const hostname = normalizeHostname(body.data.hostname);
    const validation = validateCustomDomain(hostname);
    if (!validation.valid) {
      return NextResponse.json({ error: validation.reason }, { status: 400 });
    }

    // Enforce tier cap: check the drive owner's plan limit outside the transaction
    // (subscription tier doesn't change mid-request).
    const maxAllowed = await getMaxCustomDomainsForDrive(driveId);

    if (maxAllowed === 0) {
      return NextResponse.json(
        { error: 'Custom domains are not available on your current plan. Upgrade to add a custom domain.' },
        { status: 403 },
      );
    }

    // Atomic count-check + insert. Lock the drive row first to serialize
    // concurrent requests on the same drive and prevent over-the-cap inserts.
    let inserted: { id: string; driveId: string; hostname: string; status: string; createdAt: Date };
    try {
      const rows = await db.transaction(async (tx) => {
        await tx.select({ id: drives.id }).from(drives).where(eq(drives.id, driveId)).for('update');

        const [countRow] = await tx.select({ n: count() }).from(customDomains).where(eq(customDomains.driveId, driveId));
        const existingCount = countRow?.n ?? 0;

        if (existingCount >= maxAllowed) {
          const e = Object.assign(new Error('at cap'), { code: 'cap_exceeded', maxAllowed });
          throw e;
        }

        return tx.insert(customDomains).values({ driveId, hostname }).returning();
      });
      inserted = rows[0];
    } catch (err) {
      const anyErr = err as { code?: string; maxAllowed?: number };
      if (anyErr.code === 'cap_exceeded') {
        const max = anyErr.maxAllowed!;
        return NextResponse.json(
          { error: `Your plan allows a maximum of ${max} custom domain${max === 1 ? '' : 's'} per drive.` },
          { status: 403 },
        );
      }
      if (anyErr.code === '23505') {
        return NextResponse.json({ error: 'Domain is already registered' }, { status: 409 });
      }
      throw err;
    }

    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { operation: 'add-custom-domain', hostname },
    });

    return NextResponse.json({ domain: inserted }, { status: 201 });
  } catch (error) {
    loggers.api.error('Error adding custom domain:', error as Error);
    return NextResponse.json({ error: 'Failed to add domain' }, { status: 500 });
  }
}
