/**
 * The credential ceiling a DEFERRED run executes under.
 *
 * A workflow (cron, task trigger, calendar trigger, webhook) is authored now and
 * runs later, as `createdBy`, with nobody's request in hand. When a drive-scoped
 * credential authored it, that credential's ceiling is persisted on the row
 * (`workflows.credentialCeiling`) and re-applied here, so the run can never do
 * more than its author could — and once the author credential stops working
 * (revoked key, revoked or expired grant family, suspended user), the run is
 * refused rather than falling back to the user's full reach.
 *
 * The decision is pure (`decideAuthoringScope`); the loader only gathers facts.
 */
import { db } from '@pagespace/db/db';
import { and, eq, gt, isNull } from '@pagespace/db/operators';
import { mcpTokens, users } from '@pagespace/db/schema/auth';
import { mcpTokenDrives } from '@pagespace/db/schema/members';
import { oauthAccessTokens, oauthClients, oauthRefreshTokens } from '@pagespace/db/schema/oauth';
import { workflows } from '@pagespace/db/schema/workflows';
import { credentialCeilingSchema, type CredentialCeiling } from '@pagespace/lib/permissions/credential-ceiling';
import type { ToolExecutionContext } from '@/lib/ai/core/types';

export type AuthoringScope = Pick<ToolExecutionContext, 'mcpAllowedDriveIds' | 'credentialCeiling'>;

export type AuthoringScopeDecision =
  | { readonly ok: true; readonly scope: AuthoringScope }
  | { readonly ok: false; readonly reason: string };

export interface AuthoringFacts {
  /** The raw column value — parsed here, never trusted. */
  readonly stored: unknown;
  /** Who the run executes as. */
  readonly runUserId: string;
  /** Whether that user may act at all right now (exists, not suspended). */
  readonly runUserActive: boolean;
  /** For an mcp ceiling: the key as it is NOW, or null when no such key row exists. */
  readonly mcpKey?: { readonly userId: string; readonly revoked: boolean; readonly driveIds: readonly string[] } | null;
  /** For an oauth ceiling: whether its family still holds a usable token for the run user. */
  readonly oauthFamilyLive?: boolean;
}

const REVOKED = 'the credential that authored this workflow no longer works (revoked, expired or its user changed); re-save it to run';

export function decideAuthoringScope(facts: AuthoringFacts): AuthoringScopeDecision {
  if (facts.stored === null || facts.stored === undefined) return { ok: true, scope: {} };

  const parsed = credentialCeilingSchema.safeParse(facts.stored);
  if (!parsed.success) return { ok: false, reason: 'the workflow\'s stored credential ceiling is unreadable' };
  const ceiling: CredentialCeiling = parsed.data;

  if (!facts.runUserActive) return { ok: false, reason: REVOKED };

  if (ceiling.kind === 'mcp') {
    const key = facts.mcpKey;
    if (!key || key.revoked || key.userId !== facts.runUserId || key.driveIds.length === 0) {
      return { ok: false, reason: REVOKED };
    }
    return { ok: true, scope: { mcpAllowedDriveIds: [...key.driveIds], credentialCeiling: ceiling } };
  }

  if (!ceiling.familyId || !facts.oauthFamilyLive || ceiling.driveScopes.length === 0) {
    return { ok: false, reason: REVOKED };
  }
  return {
    ok: true,
    scope: { mcpAllowedDriveIds: ceiling.driveScopes.map((row) => row.driveId), credentialCeiling: ceiling },
  };
}

/** Whether an OAuth token family still holds a token that would authenticate for `userId` now. */
async function isOAuthFamilyLive(familyId: string, userId: string, tokenVersion: number, now: Date): Promise<boolean> {
  const liveRefresh = await db
    .select({ id: oauthRefreshTokens.id })
    .from(oauthRefreshTokens)
    .innerJoin(oauthClients, eq(oauthRefreshTokens.clientId, oauthClients.id))
    .where(and(
      eq(oauthRefreshTokens.familyId, familyId),
      eq(oauthRefreshTokens.userId, userId),
      eq(oauthRefreshTokens.tokenVersion, tokenVersion),
      isNull(oauthRefreshTokens.revokedAt),
      isNull(oauthRefreshTokens.replacedByTokenId),
      gt(oauthRefreshTokens.expiresAt, now),
      gt(oauthRefreshTokens.familyExpiresAt, now),
      isNull(oauthClients.disabledAt),
    ))
    .limit(1);
  if (liveRefresh.length > 0) return true;

  const liveAccess = await db
    .select({ id: oauthAccessTokens.id })
    .from(oauthAccessTokens)
    .innerJoin(oauthClients, eq(oauthAccessTokens.clientId, oauthClients.id))
    .where(and(
      eq(oauthAccessTokens.familyId, familyId),
      eq(oauthAccessTokens.userId, userId),
      eq(oauthAccessTokens.tokenVersion, tokenVersion),
      isNull(oauthAccessTokens.revokedAt),
      gt(oauthAccessTokens.expiresAt, now),
      isNull(oauthClients.disabledAt),
    ))
    .limit(1);
  return liveAccess.length > 0;
}

/** Gather the facts for one workflow and decide. */
export async function resolveWorkflowAuthoringScope(workflowId: string, runUserId: string): Promise<AuthoringScopeDecision> {
  const [row] = await db
    .select({ stored: workflows.credentialCeiling })
    .from(workflows)
    .where(eq(workflows.id, workflowId))
    .limit(1);
  const stored: unknown = row?.stored ?? null;
  if (stored === null) return decideAuthoringScope({ stored, runUserId, runUserActive: true });

  const [user] = await db
    .select({ tokenVersion: users.tokenVersion, suspendedAt: users.suspendedAt })
    .from(users)
    .where(eq(users.id, runUserId))
    .limit(1);
  const runUserActive = !!user && !user.suspendedAt;

  const parsed = credentialCeilingSchema.safeParse(stored);
  if (!parsed.success || !user) return decideAuthoringScope({ stored, runUserId, runUserActive });

  if (parsed.data.kind === 'mcp') {
    const [key] = await db
      .select({ userId: mcpTokens.userId, revokedAt: mcpTokens.revokedAt })
      .from(mcpTokens)
      .where(eq(mcpTokens.id, parsed.data.tokenId))
      .limit(1);
    const driveRows = key
      ? await db.select({ driveId: mcpTokenDrives.driveId }).from(mcpTokenDrives).where(eq(mcpTokenDrives.tokenId, parsed.data.tokenId))
      : [];
    return decideAuthoringScope({
      stored,
      runUserId,
      runUserActive,
      mcpKey: key ? { userId: key.userId, revoked: key.revokedAt !== null, driveIds: driveRows.map((r) => r.driveId) } : null,
    });
  }

  const oauthFamilyLive = parsed.data.familyId
    ? await isOAuthFamilyLive(parsed.data.familyId, runUserId, user.tokenVersion, new Date())
    : false;
  return decideAuthoringScope({ stored, runUserId, runUserActive, oauthFamilyLive });
}
