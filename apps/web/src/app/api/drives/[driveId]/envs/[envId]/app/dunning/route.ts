/**
 * A published app's dedicated-tier Stripe subscription state —
 * `/api/drives/[driveId]/envs/[envId]/app/dunning`.
 *
 * GET → { subscription: { status, cancelAtPeriodEnd, currentPeriodEnd } | null, purchasable: boolean }
 *
 * Read-tier like the app status route: any accepted drive member. Dunning
 * state ("this always-on app is on a past_due card") is exactly what an owner
 * needs to see honestly rather than a machine silently degrading, and hiding
 * it from non-owner members buys nothing — the buy/cancel actions themselves
 * stay OWNER-only (stricter than the ADMIN/OWNER `canManage` gate elsewhere on
 * this app, because they spend the drive's money) at `/dedicated`.
 *
 * `purchasable` mirrors `isDedicatedTierPurchasable()` so the UI can hide the
 * "Buy always-on" button on a deployment where dedicated hosting isn't sold
 * (tenant/onprem, or billing off) rather than showing a button that always
 * 404s.
 */

import { NextResponse } from 'next/server';
import {
  authenticateRequestWithOptions,
  isAuthError,
  checkMCPDriveScope,
  isPrincipalDriveMember,
} from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { resolveEnvInDrive } from '@/lib/drive-envs/drive-envs-runtime';
import {
  findDedicatedSubscriptionForApp,
  isDedicatedTierPurchasable,
} from '@pagespace/lib/services/app-hosting/dedicated-tier-service';
import { findPublishedAppByEnvId } from '@/lib/app-hosting/published-app-dto';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };

export async function GET(request: Request, context: { params: Promise<{ driveId: string; envId: string }> }) {
  try {
    const { driveId, envId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;

    const scopeError = checkMCPDriveScope(auth, driveId);
    if (scopeError) return scopeError;

    if (!(await isPrincipalDriveMember(auth, driveId))) {
      return NextResponse.json({ error: 'Not a member of this drive' }, { status: 403 });
    }

    if (!(await resolveEnvInDrive(envId, driveId))) {
      return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
    }

    const app = await findPublishedAppByEnvId(envId);
    if (!app) return NextResponse.json({ error: 'This environment is not published' }, { status: 404 });

    const purchasable = isDedicatedTierPurchasable();

    const mirror = await findDedicatedSubscriptionForApp(app.id);
    if (!mirror) return NextResponse.json({ subscription: null, purchasable });

    return NextResponse.json({
      subscription: {
        status: mirror.status,
        cancelAtPeriodEnd: mirror.cancelAtPeriodEnd,
        currentPeriodEnd: mirror.currentPeriodEnd,
      },
      purchasable,
    });
  } catch (error) {
    loggers.api.error('Failed to read dedicated-tier dunning state', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to read subscription state' }, { status: 500 });
  }
}
