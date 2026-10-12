/**
 * POL-1 for the sign-in keys (D-OW-45): who a sign-in policy refuses right now, by count. IO only; the rule is
 * countSignInBlocked (authentication-policy-core.ts).
 *
 * A sign-in policy suspends nothing (a credential is judged when it is used), so "listed in the audit log" means the
 * number of the org's members holding no live credential the policy admits, and the number of live credentials it
 * refuses. Counts only: no identities, no PII. The credentials read are the long-lived ones a person signs in with:
 * user sessions (web, desktop, mobile), device tokens, MCP tokens and OAuth refresh tokens (CLI). Short-lived
 * derivatives (socket and access tokens) carry the same evidence as their parent and are not counted twice.
 */
import { db } from '@pagespace/db/db';
import { and, eq, gt, isNull } from '@pagespace/db/operators';
import { deviceTokens, mcpTokens } from '@pagespace/db/schema/auth';
import { sessions } from '@pagespace/db/schema/sessions';
import { oauthRefreshTokens } from '@pagespace/db/schema/oauth';
import { orgMembers } from '@pagespace/db/schema/organizations';
import { parseVerifiedAuthentication, type VerifiedAuthentication } from '../auth/authentication-evidence';
import { countSignInBlocked, type OrgAuthenticationPolicy } from './authentication-policy-core';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export interface SignInBlockedCounts {
  readonly members: number;
  readonly credentials: number;
}

type Row = { userId: string; authenticatedAt: Date | null; authenticationAssurance: string | null };

/** Every live credential an org member signs in with, with its evidence. */
async function listMemberCredentials(executor: Executor, orgId: string, now: Date): Promise<Array<{ userId: string; authentication: VerifiedAuthentication | null }>> {
  const member = (userColumn: typeof sessions.userId | typeof deviceTokens.userId | typeof mcpTokens.userId | typeof oauthRefreshTokens.userId) =>
    and(eq(orgMembers.userId, userColumn), eq(orgMembers.orgId, orgId));
  const [userSessions, devices, mcp, refresh] = await Promise.all([
    executor.select({ userId: sessions.userId, authenticatedAt: sessions.authenticatedAt, authenticationAssurance: sessions.authenticationAssurance })
      .from(sessions).innerJoin(orgMembers, member(sessions.userId))
      .where(and(eq(sessions.type, 'user'), isNull(sessions.revokedAt), gt(sessions.expiresAt, now))),
    executor.select({ userId: deviceTokens.userId, authenticatedAt: deviceTokens.authenticatedAt, authenticationAssurance: deviceTokens.authenticationAssurance })
      .from(deviceTokens).innerJoin(orgMembers, member(deviceTokens.userId))
      .where(and(isNull(deviceTokens.revokedAt), gt(deviceTokens.expiresAt, now))),
    executor.select({ userId: mcpTokens.userId, authenticatedAt: mcpTokens.authenticatedAt, authenticationAssurance: mcpTokens.authenticationAssurance })
      .from(mcpTokens).innerJoin(orgMembers, member(mcpTokens.userId))
      .where(isNull(mcpTokens.revokedAt)),
    executor.select({ userId: oauthRefreshTokens.userId, authenticatedAt: oauthRefreshTokens.authenticatedAt, authenticationAssurance: oauthRefreshTokens.authenticationAssurance })
      .from(oauthRefreshTokens).innerJoin(orgMembers, member(oauthRefreshTokens.userId))
      .where(and(isNull(oauthRefreshTokens.revokedAt), isNull(oauthRefreshTokens.replacedByTokenId), gt(oauthRefreshTokens.expiresAt, now))),
  ]);
  const nowMs = now.getTime();
  return ([...userSessions, ...devices, ...mcp, ...refresh] as Row[]).map((row) => ({
    userId: row.userId,
    authentication: parseVerifiedAuthentication({ authenticatedAtMs: row.authenticatedAt?.getTime(), assurance: row.authenticationAssurance }, nowMs),
  }));
}

/** How many of the org's members, and how many of their live credentials, `policy` refuses at `now`. */
export async function countOrgSignInBlocked(
  executor: Executor,
  orgId: string,
  policy: OrgAuthenticationPolicy,
  now: Date = new Date(),
): Promise<SignInBlockedCounts> {
  const credentials = await listMemberCredentials(executor, orgId, now);
  return countSignInBlocked({ policy, credentials, nowMs: now.getTime() });
}
