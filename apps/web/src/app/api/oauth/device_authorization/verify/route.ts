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
import { requiresStepUp } from '@pagespace/lib/auth/oauth/step-up-boundary';
import { describeGrantScopes } from '@pagespace/lib/auth/oauth/grant-scope-summary';
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

  let scopeDescriptions: string[] = [];
  // An empty scope list is a legitimate device-authorization request (the
  // device_authorization route leaves `scopes: []` when the initial POST omits
  // `scope` entirely) — but a NON-empty list this parser rejects is not
  // something a human can be asked to approve: the screen would render an
  // empty capability list and still offer an Allow button. Fail closed with
  // the same no-oracle response as a bad code, matching the decision route,
  // which already refuses an unparseable scope set with invalid_scope.
  const parsed = result.scopes.length > 0 ? parseScopeList(result.scopes.join(' ')) : null;
  if (parsed !== null && !parsed.ok) {
    return NextResponse.json({ error: 'invalid_code' }, { status: 400 });
  }
  // `requiresStepUp` (ADR 0004 Decision 6) is the single step-up decision —
  // the decision route enforces with the same call, so the screen can never
  // advertise a ceremony the server doesn't demand (or skip one it does).
  // Surfaced so the ceremony runs before the user clicks Allow rather than
  // failing them afterward.
  const stepUpRequired = parsed?.ok === true && requiresStepUp(parsed.scopes);

  if (parsed?.ok) {
    // An update_key grant re-scopes one of the VERIFYING user's existing keys
    // in place; an activate_key grant approves making one of them a device's
    // ambient default. Ownership (and un-revoked) is checked here so this
    // screen can only ever narrate the user's own key — a foreign, revoked, or
    // nonexistent token id all collapse to the same invalid_code response (no
    // oracle), killing the "point a victim's approval at the attacker's token"
    // direction. Mirrors the loopback consent screen (app/oauth/consent/page.tsx);
    // the decision POST re-checks server-side, this is the human-facing half.
    const targetKeyId = parsed.scopes.updateKeyId ?? parsed.scopes.activateKeyId;
    let targetKeyName: string | null = null;
    if (targetKeyId !== null) {
      const target = await sessionRepository.findActiveMcpTokenByIdAndUser(targetKeyId, auth.userId);
      if (!target) {
        return NextResponse.json({ error: 'invalid_code' }, { status: 400 });
      }
      targetKeyName = target.name;
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

    // One narration implementation for every surface (ADR 0004 Decision 4,
    // Phase 1 obligation 5) — the same list the consent screen renders.
    scopeDescriptions = describeGrantScopes(result.scopes, {
      driveNamesById,
      roleNamesById: roleById,
      keyName: targetKeyName ?? undefined,
    });
  }

  return NextResponse.json({
    userCode: normalized,
    clientName: client.name,
    firstParty: client.firstParty,
    scopeDescriptions,
    requiresStepUp: stepUpRequired,
    // The exact binding the decision route will recompute from its own
    // lookup, handed to the client so the grant it mints can't be bound to a
    // different tuple by accident. Not a trust boundary: a client that lied
    // here would mint a grant whose hash simply fails to match the server's
    // recomputed one at decision time, and the approval is refused.
    stepUpActionBinding: stepUpRequired ? { userCode: normalized, scope: result.scopes.join(' ') } : null,
  });
}
