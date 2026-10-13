/**
 * POL-1 for the sign-in keys (D-OW-45): who a sign-in policy refuses right now, by count. IO only; the rule is
 * countSignInBlocked (authentication-policy-core.ts).
 *
 * A sign-in policy suspends nothing (a credential is judged when it is used), so "listed in the audit log" means the
 * number of the org's people holding no live credential the policy admits, and the number of live credentials it
 * refuses. People are the org's members and its guests (DRV-8, D-OW-24: a non-member with a membership row on one of
 * the org's drives, or a guest hold the org queued for them), since the policy is asked of a guest on the org's drives
 * exactly as of a member. Counts only: no identities, no PII. The credentials read are the long-lived ones a person
 * signs in with: user sessions (web, desktop, mobile), device tokens, MCP tokens and OAuth refresh tokens (CLI).
 * Short-lived derivatives (socket and access tokens) carry the same evidence as their parent and are not counted twice.
 */
import { db } from '@pagespace/db/db';
import { and, eq, gt, inArray, isNull } from '@pagespace/db/operators';
import { deviceTokens, mcpTokens } from '@pagespace/db/schema/auth';
import { sessions } from '@pagespace/db/schema/sessions';
import { oauthRefreshTokens } from '@pagespace/db/schema/oauth';
import { listOrgPeople } from '../permissions/org-guest-footprint';
import { parseVerifiedAuthentication, type VerifiedAuthentication } from '../auth/authentication-evidence';
import { countSignInBlocked, type OrgAuthenticationPolicy } from './authentication-policy-core';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export interface SignInBlockedCounts {
  readonly members: number;
  readonly guests: number;
  readonly credentials: number;
}

type Row = { userId: string; authenticatedAt: Date | null; authenticationAssurance: string | null };
type Credential = { userId: string; authentication: VerifiedAuthentication | null };

/** Ids per credential read: well under Postgres's bind-parameter limit, as the policy reader chunks. */
export const BLOCKED_COUNT_CHUNK = 500;

/**
 * Every live credential the given people sign in with, with its evidence, read `chunkSize` people at a time: an org of
 * any size stays under the bind-parameter limit, so a tightening is never refused for its count (review #2866 B).
 */
async function listCredentials(executor: Executor, userIds: string[], now: Date, chunkSize: number): Promise<Credential[]> {
  const out: Credential[] = [];
  for (let i = 0; i < userIds.length; i += chunkSize) {
    out.push(...(await listCredentialsOf(executor, userIds.slice(i, i + chunkSize), now)));
  }
  return out;
}

async function listCredentialsOf(executor: Executor, userIds: string[], now: Date): Promise<Credential[]> {
  const [userSessions, devices, mcp, refresh] = await Promise.all([
    executor.select({ userId: sessions.userId, authenticatedAt: sessions.authenticatedAt, authenticationAssurance: sessions.authenticationAssurance })
      .from(sessions)
      .where(and(inArray(sessions.userId, userIds), eq(sessions.type, 'user'), isNull(sessions.revokedAt), gt(sessions.expiresAt, now))),
    executor.select({ userId: deviceTokens.userId, authenticatedAt: deviceTokens.authenticatedAt, authenticationAssurance: deviceTokens.authenticationAssurance })
      .from(deviceTokens)
      .where(and(inArray(deviceTokens.userId, userIds), isNull(deviceTokens.revokedAt), gt(deviceTokens.expiresAt, now))),
    executor.select({ userId: mcpTokens.userId, authenticatedAt: mcpTokens.authenticatedAt, authenticationAssurance: mcpTokens.authenticationAssurance })
      .from(mcpTokens)
      .where(and(inArray(mcpTokens.userId, userIds), isNull(mcpTokens.revokedAt))),
    executor.select({ userId: oauthRefreshTokens.userId, authenticatedAt: oauthRefreshTokens.authenticatedAt, authenticationAssurance: oauthRefreshTokens.authenticationAssurance })
      .from(oauthRefreshTokens)
      .where(and(inArray(oauthRefreshTokens.userId, userIds), isNull(oauthRefreshTokens.revokedAt), isNull(oauthRefreshTokens.replacedByTokenId), gt(oauthRefreshTokens.expiresAt, now))),
  ]);
  const nowMs = now.getTime();
  return ([...userSessions, ...devices, ...mcp, ...refresh] as Row[]).map((row) => ({
    userId: row.userId,
    authentication: parseVerifiedAuthentication({ authenticatedAtMs: row.authenticatedAt?.getTime(), assurance: row.authenticationAssurance }, nowMs),
  }));
}

/** How many of the org's members and guests, and how many of their live credentials, `policy` refuses at `now`. */
export async function countOrgSignInBlocked(
  executor: Executor,
  orgId: string,
  policy: OrgAuthenticationPolicy,
  now: Date = new Date(),
  chunkSize: number = BLOCKED_COUNT_CHUNK,
): Promise<SignInBlockedCounts> {
  const people = await listOrgPeople(orgId, executor);
  const credentials = await listCredentials(executor, [...people.members, ...people.guests], now, chunkSize);
  const nowMs = now.getTime();
  const members = countSignInBlocked({ policy, credentials: credentials.filter((c) => people.members.has(c.userId)), nowMs });
  const guests = countSignInBlocked({ policy, credentials: credentials.filter((c) => people.guests.has(c.userId)), nowMs });
  return { members: members.members, guests: guests.members, credentials: members.credentials + guests.credentials };
}
