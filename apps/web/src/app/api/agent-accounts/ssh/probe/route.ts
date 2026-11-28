import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getAccountAuthority } from '@/lib/agent-accounts/account-authority-client';
import { actorFromAuth } from '@/lib/auth/request-actor';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };
const ownerSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('user') }).strict(), z.object({ kind: z.literal('agent_page'), agentPageId: z.string().min(1).max(64) }).strict()]);
const probeBody = z.object({ owner: ownerSchema, host: z.string().min(1).max(253), port: z.number().int().min(1).max(65_535).nullable() }).strict();
const STATUS: Readonly<Record<string, number>> = { forbidden: 403, owner_not_found: 404, host_invalid: 400, port_invalid: 400, plane_unavailable: 503 };

/**
 * POST /api/agent-accounts/ssh/probe
 * The host key a server presents, for the person to compare with the server's own `ssh-keygen -l` before
 * creating an SSH account. The credential service connects only to a public address and never logs in.
 */
export async function POST(request: Request) {
  if (isOnPrem()) return NextResponse.json({ error: 'Not available' }, { status: 404 });
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const authority = getAccountAuthority();
  if (authority === null) return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  const parsed = probeBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  try {
    const probed = await authority.probeSshHost({ actor: actorFromAuth(auth), ...parsed.data });
    if (!probed.ok) {
      // A refused address is someone aiming the credential service at a private network: worth a record.
      if (probed.reason === 'forbidden' || probed.reason === 'address_refused') auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'agent_account', details: { change: 'ssh_probe', reason: probed.reason } });
      return NextResponse.json({ error: probed.reason }, { status: STATUS[probed.reason] ?? 502 });
    }
    return NextResponse.json({ target: probed.target, fingerprint: probed.fingerprint, algorithm: probed.algorithm });
  } catch (error) {
    loggers.api.error('Error probing an SSH host', error as Error);
    return NextResponse.json({ error: 'Failed to reach the server' }, { status: 500 });
  }
}
