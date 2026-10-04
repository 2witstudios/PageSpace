/**
 * Manual lifecycle actions on a published app —
 * `/api/drives/[driveId]/envs/[envId]/app/actions`.
 *
 * POST { action: 'stop' | 'resume' } → { app: AppDTO } — drive OWNER or ADMIN; and a PARKED
 * app's resume — the un-park — also by the app's creator or an org Owner/Admin.
 *
 * Resuming a PARKED app un-parks it first (`unparkPublishedApp`, review 5407898542 P1): the
 * creator, the drive lead or an org Owner/Admin (permissions/app-unpark-authority) — a plain
 * member, or a drive Admin who is none of those, is refused 403. The cap is re-checked: if the
 * creator's allowance (or the pool) still cannot cover a wake the un-park is REFUSED 409 with the
 * reason, never re-attributed to whoever clicked. Once `parked → stopped` lands the normal gated
 * wake runs, and it is audited `org.app.unparked` on an org drive.
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
  isPrincipalDriveMember,
  isPrincipalDriveOwnerOrAdmin,
} from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { resolveEnvInDrive } from '@/lib/drive-envs/drive-envs-runtime';
import { stopPublishedApp, wakePublishedApp } from '@pagespace/lib/services/app-hosting/app-lifecycle-metering';
import { unparkPublishedApp, type UnparkHeld } from '@pagespace/lib/services/app-hosting/app-unpark';
import { findPublishedAppByEnvId, findPublishedAppById, toPublishedAppDTO } from '@/lib/app-hosting/published-app-dto';

/** Why a parked app cannot be un-parked yet, in words for the person who asked. */
const UNPARK_HELD_MESSAGES: Readonly<Record<UnparkHeld, string>> = {
  still_capped:
    "This app is still paused: its creator's allowance of the organization's credits (or the organization's credits) cannot cover it yet. It returns automatically when that renews, or raise the allowance and try again.",
  daily_cap: 'This app used its whole daily awake budget. It returns automatically at midnight UTC.',
  org_policy: "This organization doesn't allow published apps.",
  unresolved_payer: 'This app cannot be un-parked right now. Try again shortly.',
};

const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

export async function POST(request: Request, context: { params: Promise<{ driveId: string; envId: string }> }) {
  try {
    const { driveId, envId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;

    const scopeError = checkMCPDriveScope(auth, driveId);
    if (scopeError) return scopeError;

    const denied = () => {
      auditRequest(request, {
        eventType: 'authz.access.denied',
        userId: auth.userId,
        resourceType: 'drive',
        resourceId: driveId,
        details: { route: 'drive-envs-app-actions', envId },
      });
      return NextResponse.json({ error: 'Only drive owners and admins can manage a published app' }, { status: 403 });
    };
    // A drive owner/admin may run every action. Any other drive member gets as far as a PARKED
    // app's resume, whose un-park authority (creator, lead, org Owner/Admin) is decided below.
    const canManage = await isPrincipalDriveOwnerOrAdmin(auth, driveId);
    if (!canManage && !(await isPrincipalDriveMember(auth, driveId))) return denied();

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

    const unparking = action === 'resume' && app.status === 'parked';
    if (!canManage && !unparking) return denied();

    if (unparking) {
      const unpark = await unparkPublishedApp({ publishedAppId: app.id, actorId: auth.userId });
      if (unpark.outcome === 'refused' && unpark.reason === 'forbidden') {
        auditRequest(request, {
          eventType: 'authz.access.denied',
          userId: auth.userId,
          resourceType: 'drive',
          resourceId: driveId,
          details: { route: 'drive-envs-app-actions', envId, action: 'unpark' },
        });
        return NextResponse.json(
          { error: "Only the app's creator, the drive's lead or an organization Owner or Admin can un-park it" },
          { status: 403 },
        );
      }
      if (unpark.outcome === 'held') {
        return NextResponse.json(
          { error: UNPARK_HELD_MESSAGES[unpark.held], reason: unpark.held, ...(unpark.gateReason ? { gateReason: unpark.gateReason } : {}) },
          { status: 409 },
        );
      }
      // Un-parked, or the row moved under us (not parked any more): either way the wake below
      // decides, through the same gate, from the row as it now is.
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
