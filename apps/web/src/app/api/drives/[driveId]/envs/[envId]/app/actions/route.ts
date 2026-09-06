/**
 * Manual lifecycle actions on a published app —
 * `/api/drives/[driveId]/envs/[envId]/app/actions`.
 *
 * POST { action: 'stop' | 'resume' } → { app: AppDTO } — drive OWNER or ADMIN.
 *
 * `'stop'` calls `stopPublishedApp(..., 'operator')` — an operator-requested
 * stop, distinct from the idle reaper's `'idle'` and the credit gate's
 * `'insolvent'`. `'resume'` calls `wakePublishedApp`, which re-runs the credit
 * gate: an insolvent app's resume comes back `parked`, not `woken` — that is
 * reported, not treated as a failure.
 *
 * There is deliberately NO manual `'park'` action. Parking is the credit
 * gate's own enforcement outcome (`wakePublishedApp` parks an app itself when
 * the payer can't cover it) — an operator "park my own paying app" verb isn't
 * a real use case the task's "stop/park/resume/unpublish/delete" list
 * actually needs; the pane surfaces `parked` as a status, not a button.
 */

import { NextResponse } from 'next/server';
import {
  authenticateRequestWithOptions,
  isAuthError,
  checkMCPDriveScope,
  isPrincipalDriveOwnerOrAdmin,
} from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { resolveEnvInDrive } from '@/lib/drive-envs/drive-envs-runtime';
import { stopPublishedApp, wakePublishedApp } from '@pagespace/lib/services/app-hosting/app-lifecycle-metering';
import { findPublishedAppByEnvId, findPublishedAppById, toPublishedAppDTO } from '@/lib/app-hosting/published-app-dto';

const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

export async function POST(request: Request, context: { params: Promise<{ driveId: string; envId: string }> }) {
  try {
    const { driveId, envId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;

    const scopeError = checkMCPDriveScope(auth, driveId);
    if (scopeError) return scopeError;

    if (!(await isPrincipalDriveOwnerOrAdmin(auth, driveId))) {
      auditRequest(request, {
        eventType: 'authz.access.denied',
        userId: auth.userId,
        resourceType: 'drive',
        resourceId: driveId,
        details: { route: 'drive-envs-app-actions', envId },
      });
      return NextResponse.json({ error: 'Only drive owners and admins can manage a published app' }, { status: 403 });
    }

    if (!(await resolveEnvInDrive(envId, driveId))) {
      return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
    }

    const app = await findPublishedAppByEnvId(envId);
    if (!app) return NextResponse.json({ error: 'This environment is not published' }, { status: 404 });

    const body = await request.json().catch(() => null);
    const action = (body as { action?: unknown } | null)?.action;
    if (action !== 'stop' && action !== 'resume') {
      return NextResponse.json({ error: "action must be 'stop' or 'resume'" }, { status: 400 });
    }

    if (action === 'stop') {
      const result = await stopPublishedApp(app.id, 'operator');
      if (result.outcome === 'refused') {
        return NextResponse.json({ error: `Stop refused: ${result.reason}`, reason: result.reason }, { status: 409 });
      }
      if (result.outcome === 'lock_busy') {
        return NextResponse.json({ error: 'Another lifecycle operation is in progress; try again shortly' }, { status: 409 });
      }
      if (result.outcome === 'stop_failed') {
        return NextResponse.json({ error: `Stop failed: ${result.error}` }, { status: 502 });
      }
    } else {
      const result = await wakePublishedApp(app.id);
      if (result.outcome === 'refused') {
        return NextResponse.json({ error: `Resume refused: ${result.reason}`, reason: result.reason }, { status: 409 });
      }
      if (result.outcome === 'start_failed') {
        return NextResponse.json({ error: `Resume failed: ${result.error}` }, { status: 502 });
      }
      // 'parked' is a legitimate, reportable outcome (the credit gate refused the
      // wake) — fall through to re-read the row and return its real status.
    }

    const updated = await findPublishedAppById(app.id);
    if (!updated) return NextResponse.json({ error: 'App no longer exists' }, { status: 404 });

    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { route: 'drive-envs-app-actions', envId, publishedAppId: app.id, action },
    });

    return NextResponse.json({ app: toPublishedAppDTO(updated) });
  } catch (error) {
    loggers.api.error('Failed to run published-app action', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to run action' }, { status: 500 });
  }
}
