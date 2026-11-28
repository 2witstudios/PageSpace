import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { getAccountAuthority } from '@/lib/agent-accounts/account-authority-client';
import { actorFromAuth } from '@/lib/auth/request-actor';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };
const ownerSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('user') }).strict(), z.object({ kind: z.literal('agent_page'), agentPageId: z.string().min(1).max(64) }).strict()]);
const createBody = z
  .object({
    owner: ownerSchema,
    name: z.string().min(1).max(100),
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65_535).nullable(),
    username: z.string().min(1).max(64),
    hostKeySha256: z.string().min(1).max(128),
    ownership: z.enum(['dedicated', 'personal']),
    acknowledged: z.boolean(),
    runWithoutAsking: z.boolean(),
  })
  .strict();
const STATUS: Readonly<Record<string, number>> = { forbidden: 403, owner_not_found: 404, plane_unavailable: 503, store_refused: 502 };

/**
 * POST /api/agent-accounts/ssh
 * Create an SSH account for an agent (or your global assistant). The credential service generates the key
 * and pins the host key you confirmed; the answer carries the PUBLIC key to add to the server's
 * ~/.ssh/authorized_keys. The private key never leaves the credential service.
 */
export async function POST(request: Request) {
  if (isOnPrem()) return NextResponse.json({ error: 'Not available' }, { status: 404 });
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const authority = getAccountAuthority();
  if (authority === null) return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  const parsed = createBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  const { owner, ...input } = parsed.data;
  try {
    const result = await authority.createSshAccount({ actor: actorFromAuth(auth), owner, input });
    if (!result.ok) return NextResponse.json({ error: result.reason }, { status: STATUS[result.reason] ?? 400 });
    auditRequest(request, { eventType: 'authz.permission.granted', userId: auth.userId, resourceType: 'agent_account', resourceId: result.account.id, details: { change: 'create', kind: 'ssh_key' } });
    return NextResponse.json({ account: result.account, publicKey: result.publicKey }, { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating an SSH agent account', error as Error);
    return NextResponse.json({ error: 'Failed to create the account' }, { status: 500 });
  }
}
