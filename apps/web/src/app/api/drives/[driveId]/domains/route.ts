import { NextResponse } from 'next/server';
import { z } from 'zod';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { normalizeHostname, validateCustomDomain, PLATFORM_OWNED_DOMAINS } from '@pagespace/lib/validators/custom-domain';
import { db } from '@pagespace/db/db';
import { eq, count } from '@pagespace/db/operators';
import { customDomains } from '@pagespace/db/schema/custom-domains';
import { drives } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { getPlan } from '@/lib/subscription/plans';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { reconcileCustomDomainCert } from '@/lib/canvas/reconcile-cert';
import { mirrorDriveToCustomHost } from '@/lib/canvas/custom-domain-mirror';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError, checkMCPDriveScope } from '@/lib/auth/auth-core';
import { isPrincipalDriveOwnerOrAdmin } from '@/lib/auth/principal-permissions';

/** Statuses whose cert is still advancing — worth a lazy reconcile on read. */
const CERT_NON_TERMINAL = new Set(['verified', 'provisioning']);

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

    // Lazy cert reconcile (no cron): for each row whose cert is still advancing
    // (verified | provisioning), advance it one step so the badge + canonical
    // self-heal on any settings visit. Best-effort and bounded — typically 0–1
    // rows, run concurrently; a Fly outage must NOT break the list response.
    // `allowFailureTransition: false` keeps a read non-destructive — a transient
    // Fly error never flips a DNS-valid domain to cert_failed or wipes its
    // content; that is reserved for the explicit "Check SSL" action. Content
    // already serves without this (mirrored at verify time).
    const reconciled = await Promise.all(
      domains.map(async (domain) => {
        if (!CERT_NON_TERMINAL.has(domain.status)) return domain;
        try {
          const { status } = await reconcileCustomDomainCert(domain, { allowFailureTransition: false });
          return { ...domain, status };
        } catch (err) {
          loggers.api.warn('Lazy cert reconcile failed during domains list', {
            driveId,
            hostname: domain.hostname,
            error: err instanceof Error ? err.message : String(err),
          });
          return domain;
        }
      }),
    );

    return NextResponse.json({ domains: reconciled, limit });
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

    // Platform admin = `users.role === 'admin'` — distinct from drive-level owner/admin membership.
    const isAdmin = auth.role === 'admin';
    if (!isAdmin && !(await isPrincipalDriveOwnerOrAdmin(auth, driveId))) {
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
    // Platform admins may register a platform-owned domain (e.g. pagespace.ai)
    // as a custom domain to alias a drive's published content onto the app's
    // own domain. This bypasses the normal pending -> verify -> provision
    // flow and the subscription-tier cap entirely — it isn't a customer-facing
    // custom domain slot.
    const wantsPlatformDomain = isAdmin && PLATFORM_OWNED_DOMAINS.includes(hostname);

    const validation = validateCustomDomain(hostname, { allowPlatformDomain: wantsPlatformDomain });
    if (!validation.valid) {
      return NextResponse.json({ error: validation.reason }, { status: 400 });
    }

    let inserted: { id: string; driveId: string; hostname: string; status: string; createdAt: Date };

    if (wantsPlatformDomain) {
      try {
        const rows = await db
          .insert(customDomains)
          .values({ driveId, hostname, status: 'active', platformOwned: true })
          .returning();
        inserted = rows[0];
      } catch (err) {
        const anyErr = err as { code?: string };
        if (anyErr.code === '23505') {
          return NextResponse.json({ error: 'Domain is already registered' }, { status: 409 });
        }
        throw err;
      }

      // Nothing else triggers this backfill for a row inserted straight as
      // `active` — the existing backfill only fires on the pending -> active
      // TRANSITION inside reconcileCustomDomainCert, which this path bypasses.
      mirrorDriveToCustomHost(driveId, hostname).catch((err) => {
        loggers.api.warn('Failed to backfill platform-owned domain mirror', {
          driveId,
          hostname,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } else {
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
    }

    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { operation: 'add-custom-domain', hostname, platformOwned: wantsPlatformDomain },
    });

    return NextResponse.json({ domain: inserted }, { status: 201 });
  } catch (error) {
    loggers.api.error('Error adding custom domain:', error as Error);
    return NextResponse.json({ error: 'Failed to add domain' }, { status: 500 });
  }
}
