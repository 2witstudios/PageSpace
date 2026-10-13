import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { z } from 'zod';
import { getOrgPoolSplit, setOrgPoolPaused } from '@pagespace/lib/services/drive-wallet-service';
import { authorizeOrgRequest, ORG_READ_AUTH, ORG_SESSION_WRITE_AUTH } from '@/lib/orgs/org-route-auth';
import { safeParseBody } from '@/lib/validation/parse-body';
import { walletErrorResponse } from '@/lib/wallets/wallet-route';

/**
 * GET /api/orgs/[orgId]/pool — the org pool and where it goes: available, unallocated, seats and every
 * drive wallet (read model, D-OW-38 "pool split"; SPEND-10; UI-7). Owner and Admins only:
 * SPEND-9 keeps the pool from every consumer. Session only ([D-OW-26]: a key reads wallet views through
 * the consumer allowlist, and the pool is an admin money view; X-1 exclusion table).
 */
export async function GET(request: Request, context: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_READ_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const read = await getOrgPoolSplit(orgId);
    auditRequest(request, {
      eventType: 'data.read',
      userId: gate.userId,
      resourceType: 'organization',
      resourceId: orgId,
      details: { operation: 'read_org_pool_split', driveWallets: read.driveWallets.length },
    });
    return NextResponse.json(read);
  } catch (error) {
    loggers.api.error('Error reading the organization pool:', error as Error);
    return NextResponse.json({ error: 'Failed to load the credits pool', code: 'internal_error' }, { status: 500 });
  }
}

const poolPauseSchema = z.object({ paused: z.boolean() }).strict();

/**
 * PATCH /api/orgs/[orgId]/pool `{ paused }` — the org pool's kill switch (WAL-7). Owner and Admins, a
 * real session only (a token never changes a wallet, [D-OW-26]). A paused pool funds nothing: no seat,
 * no drive wallet under it, no org compute. Pausing applies while the org is lapsed; resuming does not
 * (SEAT-9, [D-OW-33]). Answers `{ walletId, status }`.
 */
export async function PATCH(request: Request, context: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_SESSION_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  const parsed = await safeParseBody(request, poolPauseSchema);
  if (!parsed.success) return parsed.response;
  try {
    const result = await setOrgPoolPaused(gate.userId, orgId, parsed.data.paused);
    if (!result.ok) return walletErrorResponse(result);
    auditRequest(request, {
      eventType: 'data.write',
      userId: gate.userId,
      resourceType: 'organization',
      resourceId: orgId,
      details: { operation: parsed.data.paused ? 'pause_org_pool' : 'resume_org_pool', status: result.status },
    });
    return NextResponse.json({ walletId: result.walletId, status: result.status });
  } catch (error) {
    loggers.api.error('Error pausing or resuming the organization pool:', error as Error);
    return NextResponse.json({ error: 'Failed to change the credits pool', code: 'internal_error' }, { status: 500 });
  }
}
