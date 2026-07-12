/**
 * Machines API — the Development surface's aggregated tree needs the one thing
 * no other machine route serves: every Machine in a drive, not one Machine by
 * id.
 *
 * GET ?driveId=<id> → { machines: [{ id, title, updatedAt }] }
 *
 * Session-only (no MCP/agent tokens) — a human/UI surface, like the rest of
 * `/api/machines/*`.
 *
 * App-admin only, matching the rest of the Machine feature: creating a MACHINE
 * page requires `admin` (see POST /api/pages) and `MachineView` refuses to mount
 * its tabs for anyone else. Without this, a non-admin drive member who can VIEW a
 * Machine page could enumerate the drive's machines from the Development surface.
 *
 * Note this route is STRICTER than its siblings, not a system-wide guarantee:
 * /api/machines/{projects,branches,agent-terminals} gate on `canViewMachine`, not
 * on admin, so a non-admin with view access on a Machine page can still call them
 * directly. This surface simply declines to be the thing that hands them the list
 * of machines to call them with.
 *
 * Admin is necessary but not sufficient: the list is still filtered per page
 * through `canUserViewPage`, so a Machine withheld from this admin by a
 * page-level grant never appears.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { listDriveMachines } from '@/lib/machines/machine-list-runtime';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };

export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  const driveId = new URL(request.url).searchParams.get('driveId');
  if (!driveId) {
    return NextResponse.json({ error: 'driveId is required' }, { status: 400 });
  }

  if (auth.role !== 'admin') {
    auditRequest(request, {
      eventType: 'authz.access.denied',
      userId: auth.userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { reason: 'app_admin_required', method: 'GET', route: 'machines' },
      riskScore: 0.5,
    });
    return NextResponse.json({ error: 'Machines require administrator privileges' }, { status: 403 });
  }

  try {
    const machines = await listDriveMachines(auth.userId, driveId);
    return NextResponse.json({ machines });
  } catch (error) {
    loggers.api.error('Error listing machines:', error as Error);
    return NextResponse.json({ error: 'Failed to list machines' }, { status: 500 });
  }
}
