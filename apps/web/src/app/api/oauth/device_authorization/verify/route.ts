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
  // Whether approving this code is a credential-escalation act (minting a new
  // key, re-scoping an existing one, or making one a device's ambient
  // default) rather than an ordinary login. The decision route requires a
  // step-up grant for exactly these; surfaced here so the screen can run the
  // ceremony before the user clicks Allow rather than failing them afterward.
  let requiresStepUp = false;

  if (parsed?.ok) {
    // An update_key grant re-scopes one of the VERIFYING user's existing keys
    // in place; an activate_key grant approves making one of them a device's
    // ambient default. Ownership (and un-revoked) is checked here so this
    // screen can only ever narrate the user's own key — a foreign, revoked, or
    // nonexistent token id all collapse to the same invalid_code response (no
    // oracle), killing the "point a victim's approval at the attacker's token"
    // direction. Mirrors the loopback consent screen (app/oauth/consent/page.tsx);
    // the decision POST re-checks server-side, this is the human-facing half.
    let updateKeyName: string | null = null;
    let activateKeyName: string | null = null;
    const targetKeyId = parsed.scopes.updateKeyId ?? parsed.scopes.activateKeyId;
    if (targetKeyId !== null) {
      const target = await sessionRepository.findActiveMcpTokenByIdAndUser(targetKeyId, auth.userId);
      if (!target) {
        return NextResponse.json({ error: 'invalid_code' }, { status: 400 });
      }
      if (parsed.scopes.updateKeyId !== null) updateKeyName = target.name;
      else activateKeyName = target.name;
    }

    // Named first so the user reads "this creates a key named X" before the
    // capability list that follows — same ordering as the consent screen.
    if (parsed.scopes.newKeyName !== null) {
      requiresStepUp = true;
      scopeDescriptions.push(describeScopeForConsent({ kind: 'name', name: parsed.scopes.newKeyName }, {}));
    }
    if (parsed.scopes.updateKeyId !== null) {
      requiresStepUp = true;
      scopeDescriptions.push(
        describeScopeForConsent(
          { kind: 'update_key', tokenId: parsed.scopes.updateKeyId },
          { keyName: updateKeyName ?? undefined },
        ),
      );
    }
    if (parsed.scopes.activateKeyId !== null) {
      requiresStepUp = true;
      scopeDescriptions.push(
        describeScopeForConsent(
          { kind: 'activate_key', tokenId: parsed.scopes.activateKeyId },
          { keyName: activateKeyName ?? undefined },
        ),
      );
    }
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
    requiresStepUp,
    // The exact binding the decision route will recompute from its own
    // lookup, handed to the client so the grant it mints can't be bound to a
    // different tuple by accident. Not a trust boundary: a client that lied
    // here would mint a grant whose hash simply fails to match the server's
    // recomputed one at decision time, and the approval is refused.
    stepUpActionBinding: requiresStepUp ? { userCode: normalized, scope: result.scopes.join(' ') } : null,
  });
}
