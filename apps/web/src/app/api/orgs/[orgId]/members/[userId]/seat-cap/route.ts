import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { setSeatCap } from '@pagespace/lib/services/drive-wallet-service';
import { authorizeOrgRequest, ORG_WRITE_AUTH } from '@/lib/orgs/org-route-auth';
import { safeParseBody } from '@/lib/validation/parse-body';
import { consumerCapSchema } from '@/lib/wallets/consumer-cap-schema';
import { walletErrorResponse } from '@/lib/wallets/wallet-route';
import type { ConsumerCapWriteInput } from '@pagespace/lib/billing/wallet-core';

type Context = { params: Promise<{ orgId: string; userId: string }> };

/**
 * A member's caps on the org pool leg — their seat (Spec WAL-7, WAL-2). Owner and Admins only.
 *
 * PUT     `{ dailyCapCents?, monthlyCapCents? }` (whole cents; null = no cap in that window; the
 *         monthly window is this member's seat allowance). Answers `{ walletId, caps }`.
 * DELETE  clears it: the member's seat falls back to the org's allowance.
 */
async function write(request: Request, context: Context, clear: boolean) {
  const { orgId, userId: consumerId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  let input: ConsumerCapWriteInput | null = null;
  if (!clear) {
    const parsed = await safeParseBody(request, consumerCapSchema);
    if (!parsed.success) return parsed.response;
    input = { dailyCents: parsed.data.dailyCapCents, monthlyCents: parsed.data.monthlyCapCents };
  }
  try {
    const result = await setSeatCap(gate.userId, orgId, consumerId, input);
    if (!result.ok) return walletErrorResponse(result);
    auditRequest(request, {
      eventType: 'data.write',
      userId: gate.userId,
      resourceType: 'organization_member',
      resourceId: orgId,
      details: { operation: clear ? 'clear_seat_cap' : 'set_seat_cap', targetUserId: consumerId },
    });
    return NextResponse.json({ walletId: result.walletId, caps: result.caps });
  } catch (error) {
    loggers.api.error('Error writing a seat cap:', error as Error);
    return NextResponse.json({ error: 'Failed to write the seat cap' }, { status: 500 });
  }
}

export async function PUT(request: Request, context: Context) {
  return write(request, context, false);
}

export async function DELETE(request: Request, context: Context) {
  return write(request, context, true);
}
