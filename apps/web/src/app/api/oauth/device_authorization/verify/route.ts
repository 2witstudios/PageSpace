/**
 * Session-gated user-code verification for the /activate screen (task
 * mwexjazwha2uhw5bmvc9a7kw). Read-only: normalizes the submitted code,
 * rate-limits aggressively per session AND per IP (short human-typed codes
 * are brute-forceable — this is the attack surface of the whole device
 * flow), and returns the requesting client's identity + the SAME scope
 * narration task 6's consent screen uses — never the device/user code
 * record itself.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError, getClientIP } from '@/lib/auth';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { normalizeUserCode } from '@pagespace/lib/auth/oauth/user-code';
import { getRegisteredClient } from '@pagespace/lib/auth/oauth/clients';
import { parseScopeList } from '@pagespace/lib/auth/oauth/scopes';
import { describeScopeForConsent } from '@pagespace/lib/auth/oauth/consent';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { driveRoles } from '@pagespace/db/schema/members';
import { verifyDeviceUserCode } from '@/lib/repositories/oauth-repository';
import { sessionRepository } from '@/lib/repositories/session-repository';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const bodySchema = z.object({ userCode: z.string().min(1).max(32) });

export async function POST(req: NextRequest) {
  const auth = await authenticateRequestWithOptions(req, { allow: ['session'], requireCSRF: false });
  if (isAuthError(auth)) return auth.error;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const ip = getClientIP(req);
  const [ipLimit, sessionLimit] = await Promise.all([
    checkDistributedRateLimit(`oauth-device-verify:ip:${ip}`, DISTRIBUTED_RATE_LIMITS.OAUTH_VERIFY),
    checkDistributedRateLimit(`oauth-device-verify:session:${auth.userId}`, DISTRIBUTED_RATE_LIMITS.OAUTH_VERIFY),
  ]);

  if (!ipLimit.allowed || !sessionLimit.allowed) {
    auditRequest(req, {
      eventType: 'security.rate.limited',
      userId: auth.userId,
      details: { oauthEvent: 'device_verify_rate_limited' },
    });
    const retryAfter = Math.max(ipLimit.retryAfter ?? 0, sessionLimit.retryAfter ?? 0);
    return NextResponse.json({ error: 'rate_limited', retryAfter }, { status: 429 });
  }

  const normalized = normalizeUserCode(body.userCode);
  const result = await verifyDeviceUserCode({ userCode: normalized, now: new Date() });

  if (result.outcome !== 'ok') {
    return NextResponse.json({ error: 'invalid_code' }, { status: 400 });
  }

  const client = getRegisteredClient(result.clientId);
  if (!client) {
    return NextResponse.json({ error: 'invalid_code' }, { status: 400 });
  }

  const scopeDescriptions: string[] = [];
  const parsed = result.scopes.length > 0 ? parseScopeList(result.scopes.join(' ')) : null;

  if (parsed?.ok) {
    if (parsed.scopes.account) {
      scopeDescriptions.push(describeScopeForConsent({ kind: 'account' }, {}));
    }
    if (parsed.scopes.offlineAccess) {
      scopeDescriptions.push(describeScopeForConsent({ kind: 'offline_access' }, {}));
    }
    if (parsed.scopes.manageKeys) {
      scopeDescriptions.push(describeScopeForConsent({ kind: 'manage_keys' }, {}));
    }

    const driveIds = [...parsed.scopes.drives.keys()];
    const drives = driveIds.length > 0 ? await sessionRepository.findDrivesByIds(driveIds) : [];
    const driveNamesById = new Map(drives.map((d) => [d.id, d.name]));

    const customRoleIds = [...parsed.scopes.drives.values()]
      .filter((scope) => scope.role.kind === 'custom')
      .map((scope) => (scope.role as { kind: 'custom'; customRoleId: string }).customRoleId);
    const roleRows =
      customRoleIds.length > 0
        ? await Promise.all(customRoleIds.map((id) => db.query.driveRoles.findFirst({ where: eq(driveRoles.id, id) })))
        : [];
    const roleById = new Map(roleRows.filter((r): r is NonNullable<typeof r> => !!r).map((r) => [r.id, r]));

    for (const scope of parsed.scopes.drives.values()) {
      const driveName = driveNamesById.get(scope.driveId);
      if (scope.role.kind === 'custom') {
        const role = roleById.get(scope.role.customRoleId);
        scopeDescriptions.push(
          describeScopeForConsent(scope, { driveName, roleName: role?.name, roleSummary: role?.description ?? undefined }),
        );
      } else {
        scopeDescriptions.push(describeScopeForConsent(scope, { driveName }));
      }
    }
  }

  return NextResponse.json({
    userCode: normalized,
    clientName: client.name,
    firstParty: client.firstParty,
    scopeDescriptions,
  });
}
