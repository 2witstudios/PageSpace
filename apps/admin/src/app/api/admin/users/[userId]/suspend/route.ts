import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { contentSiteHolds } from '@pagespace/db/schema/content-safety';
import { withAdminAuth } from '@/lib/auth';
import { suspendUser, unsuspendUser } from '@pagespace/lib/auth/suspend-user';
import { callWebTakedown } from '@/lib/content/web-takedown';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

type RouteContext = { params: Promise<{ userId: string }> };

const suspendSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required to suspend a user').max(500),
  // Also take the user's published sites off the web. Without it a suspended
  // account's sites stay publicly served: suspension only blocks sign-in.
  parkSites: z.boolean().optional(),
});

interface SitesOutcome {
  caseId?: string;
  parkedDriveIds: string[];
  skippedDrives: Array<{ driveId: string; reason: string }>;
  error?: string;
}

function sitesMessage(sites: SitesOutcome | undefined): string {
  const base = 'User suspended and all sessions revoked';
  if (!sites) return base;
  if (sites.error) return `${base}. Their published sites could NOT be parked: ${sites.error}`;
  const parked = `${sites.parkedDriveIds.length} drive(s) had their published sites parked`;
  return sites.skippedDrives.length > 0
    ? `${base}. ${parked}; ${sites.skippedDrives.length} org drive(s) with other members were left published and need a decision.`
    : `${base}. ${parked}.`;
}

const unsuspendSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

/**
 * POST /api/admin/users/[userId]/suspend
 * Suspend a user: sets suspendedAt/suspendedReason (enforced at login and
 * session validation) and revokes all of the user's sessions immediately.
 * Requires a non-empty reason.
 *
 * With `parkSites: true` it also parks the published sites of the drives the
 * user OWNS. An org drive that other people are members of is not parked: it is
 * returned in `sites.skippedDrives` for an admin to decide through a scoped
 * takedown. The suspension stands even if the parking could not run; the
 * response says so in `sites.error`.
 */
export const POST = withAdminAuth<RouteContext>(async (adminUser, request, context) => {
  try {
    const { userId: targetUserId } = await context.params;

    if (targetUserId === adminUser.id) {
      return NextResponse.json(
        { error: 'You cannot suspend your own account' },
        { status: 400 }
      );
    }

    const parsed = suspendSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'A non-empty reason is required to suspend a user', details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    const { reason, parkSites } = parsed.data;

    // The suspension itself is shared with content takedowns (packages/lib/src/auth/suspend-user.ts).
    const outcome = await suspendUser({ userId: targetUserId, reason });
    if (outcome.status === 'not_found') {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    if (outcome.status === 'already_suspended') {
      return NextResponse.json({ error: 'User is already suspended' }, { status: 409 });
    }
    const { revokedSessions } = outcome;

    // Parking needs the publish bucket, which only the web app can reach.
    let sites: SitesOutcome | undefined;
    if (parkSites) {
      const parked = await callWebTakedown({ action: 'park_user_sites', userId: targetUserId, reason }, adminUser.id);
      sites = parked.ok
        ? {
            caseId: parked.body.caseId,
            parkedDriveIds: parked.body.parkedDriveIds ?? [],
            skippedDrives: parked.body.skippedDrives ?? [],
            ...(parked.body.failedStep ? { error: parked.body.error ?? 'Parking did not finish; resume the case' } : {}),
          }
        : { parkedDriveIds: [], skippedDrives: [], error: parked.error };
    }

    // Free-text reason stays in the audit event only — not in general API logs.
    loggers.api.info('Admin suspended user', {
      adminId: adminUser.id,
      targetUserId,
      revokedSessions,
    });

    auditRequest(request, {
      eventType: 'admin.user.suspended',
      userId: adminUser.id,
      resourceType: 'user',
      resourceId: targetUserId,
      details: {
        source: 'admin',
        action: 'suspend',
        reason,
        revokedSessions,
        ...(sites ? { parkSites: true, sitesCaseId: sites.caseId, sitesError: sites.error } : {}),
      },
    });

    if (sites) {
      auditRequest(request, {
        eventType: 'content.takedown.sites_parked',
        userId: adminUser.id,
        resourceType: 'user',
        resourceId: targetUserId,
        details: {
          source: 'admin',
          action: 'park_user_sites',
          reason,
          caseId: sites.caseId,
          parkedDriveIds: sites.parkedDriveIds,
          skippedDrives: sites.skippedDrives,
          outcome: sites.error ? 'not_completed' : 'completed',
        },
      });
    }

    return NextResponse.json({
      success: true,
      revokedSessions,
      ...(sites ? { sites } : {}),
      message: sitesMessage(sites),
    });
  } catch (error) {
    loggers.api.error('Error suspending user', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to suspend user' }, { status: 500 });
  }
});

/**
 * DELETE /api/admin/users/[userId]/suspend
 * Lift a suspension: clears suspendedAt/suspendedReason. Optional reason.
 */
export const DELETE = withAdminAuth<RouteContext>(async (adminUser, request, context) => {
  try {
    const { userId: targetUserId } = await context.params;

    const parsed = unsuspendSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    const reason = parsed.data.reason || 'Admin unsuspend';

    const outcome = await unsuspendUser(targetUserId);
    if (outcome.status === 'not_found') {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    if (outcome.status === 'not_suspended') {
      return NextResponse.json({ error: 'User is not suspended' }, { status: 409 });
    }

    // Put back the sites this user's suspension parked. Holds a takedown placed
    // on the same drives are a separate decision and stay. Only asked of the web
    // app when there is something to restore.
    let sitesRestore: { restoredDriveIds: string[]; error?: string } | undefined;
    const [hold] = await db
      .select({ driveId: contentSiteHolds.driveId })
      .from(contentSiteHolds)
      .where(and(eq(contentSiteHolds.userId, targetUserId), eq(contentSiteHolds.source, 'user_suspension')))
      .limit(1);
    if (hold) {
      const restored = await callWebTakedown({ action: 'restore_user_sites', userId: targetUserId }, adminUser.id);
      sitesRestore = restored.ok
        ? { restoredDriveIds: restored.body.restoredDriveIds ?? [] }
        : { restoredDriveIds: [], error: restored.error };
      auditRequest(request, {
        eventType: 'content.takedown.sites_restored',
        userId: adminUser.id,
        resourceType: 'user',
        resourceId: targetUserId,
        details: {
          source: 'admin',
          action: 'restore_user_sites',
          restoredDriveIds: sitesRestore.restoredDriveIds,
          outcome: sitesRestore.error ? 'not_completed' : 'completed',
        },
      });
    }

    loggers.api.info('Admin unsuspended user', {
      adminId: adminUser.id,
      targetUserId,
    });

    auditRequest(request, {
      eventType: 'admin.user.reactivated',
      userId: adminUser.id,
      resourceType: 'user',
      resourceId: targetUserId,
      details: {
        source: 'admin',
        action: 'unsuspend',
        reason,
      },
    });

    return NextResponse.json({
      success: true,
      ...(sitesRestore ? { sites: sitesRestore } : {}),
      message: sitesRestore?.error
        ? `Suspension lifted, but the user's published sites could not be restored: ${sitesRestore.error}`
        : 'Suspension lifted. The user can sign in again.',
    });
  } catch (error) {
    loggers.api.error('Error unsuspending user', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to unsuspend user' }, { status: 500 });
  }
});
