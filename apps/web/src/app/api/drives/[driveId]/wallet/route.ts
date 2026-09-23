import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { SPEND_SOURCE_KINDS, WALLET_FALLBACK_RULES } from '@pagespace/db/schema/wallets';
import {
  createDriveWallet,
  deleteDriveWallet,
  getDriveWallet,
  updateDriveWallet,
} from '@pagespace/lib/services/drive-wallet-service';
import { authenticateRequestWithOptions, checkMCPDriveScope, isAuthError } from '@/lib/auth';
import { safeParseBody } from '@/lib/validation/parse-body';
import { WALLET_READ_AUTH, WALLET_WRITE_AUTH, walletErrorResponse } from '@/lib/wallets/wallet-route';

/**
 * A drive's wallet (Spec UI-9, SPEND-9, SPEND-10, WAL-3, WAL-7).
 *
 * GET     the wallet as the caller may see it: consumers get the remaining amount and their own
 *         cap; the lead adds spend by member; org admins add the pool. `wallet` is null when the
 *         drive has none. 404 for anyone who cannot open the drive.
 * POST    create it under its parent with an allocation (org admins on org drives; the lead on
 *         a personal drive).
 * PATCH   change allocation (allocate), pause (pause), fallback, donations and default source
 *         (set_rules); a change is refused whole if any field is not the caller's to change.
 * DELETE  only a wallet that never moved money; otherwise 409 with the blockers (pause it).
 *
 * Dark while ORGS_ENABLED is false (404).
 */

type RouteContext = { params: Promise<{ driveId: string }> };

const cents = z.number().int().min(0).max(2_147_483_647);

const createSchema = z.object({ allocationCents: cents }).strict();

const patchSchema = z.object({
  allocationCents: cents.optional(),
  paused: z.boolean().optional(),
  fallbackRule: z.enum(WALLET_FALLBACK_RULES).nullable().optional(),
  donationsEnabled: z.boolean().optional(),
  defaultSpendSource: z.enum(SPEND_SOURCE_KINDS).nullable().optional(),
}).strict();

export async function GET(request: Request, context: RouteContext) {
  const { driveId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, WALLET_READ_AUTH);
  if (isAuthError(auth)) return auth.error;
  const scopeError = checkMCPDriveScope(auth, driveId);
  if (scopeError) return scopeError;
  try {
    const result = await getDriveWallet(auth.userId, driveId);
    if (!result.ok) return walletErrorResponse(result);
    auditRequest(request, {
      eventType: 'data.read',
      userId: auth.userId,
      resourceType: 'drive_wallet',
      resourceId: driveId,
      details: { operation: 'read_drive_wallet', viewer: result.viewer },
    });
    return NextResponse.json({ viewer: result.viewer, actions: result.actions, wallet: result.wallet });
  } catch (error) {
    loggers.api.error('Error reading the drive wallet:', error as Error);
    return NextResponse.json({ error: 'Failed to read the drive wallet' }, { status: 500 });
  }
}

export async function POST(request: Request, context: RouteContext) {
  const { driveId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, WALLET_WRITE_AUTH);
  if (isAuthError(auth)) return auth.error;
  const parsed = await safeParseBody(request, createSchema);
  if (!parsed.success) return parsed.response;
  try {
    const result = await createDriveWallet(auth.userId, driveId, parsed.data);
    if (!result.ok) return walletErrorResponse(result);
    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'drive_wallet',
      resourceId: driveId,
      details: { operation: 'create_drive_wallet', allocationCents: parsed.data.allocationCents },
    });
    return NextResponse.json({ viewer: result.viewer, actions: result.actions, wallet: result.wallet }, { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating the drive wallet:', error as Error);
    return NextResponse.json({ error: 'Failed to create the drive wallet' }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const { driveId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, WALLET_WRITE_AUTH);
  if (isAuthError(auth)) return auth.error;
  const parsed = await safeParseBody(request, patchSchema);
  if (!parsed.success) return parsed.response;
  try {
    const result = await updateDriveWallet(auth.userId, driveId, parsed.data);
    if (!result.ok) return walletErrorResponse(result);
    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'drive_wallet',
      resourceId: driveId,
      details: { operation: 'update_drive_wallet', fields: Object.keys(parsed.data) },
    });
    return NextResponse.json({ viewer: result.viewer, actions: result.actions, wallet: result.wallet });
  } catch (error) {
    loggers.api.error('Error updating the drive wallet:', error as Error);
    return NextResponse.json({ error: 'Failed to update the drive wallet' }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const { driveId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, WALLET_WRITE_AUTH);
  if (isAuthError(auth)) return auth.error;
  try {
    const result = await deleteDriveWallet(auth.userId, driveId);
    if (!result.ok) return walletErrorResponse(result);
    auditRequest(request, {
      eventType: 'data.delete',
      userId: auth.userId,
      resourceType: 'drive_wallet',
      resourceId: driveId,
      details: { operation: 'delete_drive_wallet' },
    });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    loggers.api.error('Error deleting the drive wallet:', error as Error);
    return NextResponse.json({ error: 'Failed to delete the drive wallet' }, { status: 500 });
  }
}
