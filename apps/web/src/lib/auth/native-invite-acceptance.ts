/**
 * Unified invite-acceptance dispatcher across the pending-invite surfaces
 * (drive, page, connection, and org invitations — ORG-3). Hashes the token
 * once, runs the repository lookups in parallel, and dispatches to the
 * matching pipe.
 *
 * `consumeAllInvitesForEmail` is the post-signup multi-invite resolver that
 * auto-accepts every drive + page invite waiting for the email. Connection
 * invites are also consumed but the resulting `connections` row is created
 * in PENDING status — the design treats connect-as-collab as a personal
 * user-to-user choice that should not be auto-promoted to ACCEPTED.
 */

import { hashToken } from '@pagespace/lib/auth/token-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  acceptConnectionInviteForExistingUser,
  acceptConnectionInviteForNewUser,
  acceptInviteForExistingUser,
  acceptInviteForNewUser,
  acceptPageInviteForExistingUser,
  acceptPageInviteForNewUser,
  emitAcceptanceSideEffects,
  emitConnectionAcceptanceSideEffects,
  emitPageAcceptanceSideEffects,
  type AcceptedConnectionData,
  type AcceptedInviteData,
  type AcceptedPageInviteData,
  type InviteAcceptanceErrorCode,
} from '@pagespace/lib/services/invites';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { pageInviteRepository } from '@/lib/repositories/page-invite-repository';
import { connectionInviteRepository } from '@/lib/repositories/connection-invite-repository';
import { buildAcceptancePorts } from './invite-acceptance-adapters';
import { buildPageAcceptancePorts } from './page-invite-acceptance-adapters';
import { buildConnectionAcceptancePorts } from './connection-invite-acceptance-adapters';
import { findInvitationByToken, type AcceptInvitationResult } from '@pagespace/lib/organizations/invitations';
import { acceptOrgInviteForUser } from '@/lib/orgs/accept-org-invite';
import { orgHubPath, orgInvitePagePath } from '@/lib/orgs/org-invite-view';

export type InviteKind = 'drive' | 'page' | 'connection' | 'org';

// Surfaces every error code the three pipes can return, plus the connection
// and page-specific extras. Routes that surface this in a query param should
// treat it as a stable enum string.
export type AnyInviteErrorCode =
  | InviteAcceptanceErrorCode
  | 'ALREADY_HAS_PERMISSION'
  | 'ALREADY_CONNECTED';

export interface NativeInviteAcceptanceInput {
  request: Request;
  inviteToken: string | undefined;
  user: { id: string; suspendedAt: Date | null };
  isNewUser: boolean;
  email: string;
}

export interface NativeInviteAcceptanceResult {
  /** The kind of invite that was consumed, if any. */
  kind: InviteKind | null;
  /** Drive id if the consumed invite was drive- or page-kind. Used by routes
   *  to compose the post-acceptance redirect target. */
  invitedDriveId: string | null;
  /** Page id if the consumed invite was page-kind. */
  invitedPageId: string | null;
  /** Connection id if the consumed invite was connection-kind. */
  connectionId: string | null;
  /** Org id if the consumed invite was an org invitation (ORG-3). */
  invitedOrgId: string | null;
  /**
   * For an org invitation only, accepted or refused: where the person lands. Accepted, the org's
   * hub; refused, the invite page again, which shows why (wrong account, expired, …) — the org
   * kind is set on a refusal too, unlike the other kinds, so no route drops the person on the
   * dashboard with only an unread `inviteError`.
   */
  orgLandingPath: string | null;
  /** Error code from the matching pipe — only set when no invite was
   *  successfully consumed. */
  inviteError?: AnyInviteErrorCode;
}

const EMPTY_RESULT: NativeInviteAcceptanceResult = {
  kind: null,
  invitedDriveId: null,
  invitedPageId: null,
  connectionId: null,
  invitedOrgId: null,
  orgLandingPath: null,
};

/** acceptInvitation's refusals, in the dispatcher's shared error vocabulary. */
const ORG_REFUSAL_CODES: Record<Extract<AcceptInvitationResult, { ok: false }>['reason'], AnyInviteErrorCode> = {
  not_found: 'TOKEN_NOT_FOUND',
  expired: 'TOKEN_EXPIRED',
  already_accepted: 'TOKEN_CONSUMED',
  email_mismatch: 'EMAIL_MISMATCH',
  org_lapsed: 'ORG_LAPSED',
};

/** The org arm: the invitation is accepted for the account that just signed in or up, or refused with the page to explain it. */
async function consumeOrgInvite(request: Request, token: string, userId: string): Promise<NativeInviteAcceptanceResult> {
  const result = await acceptOrgInviteForUser({ request, token, userId });
  if (result.ok) {
    return { ...EMPTY_RESULT, kind: 'org', invitedOrgId: result.orgId, orgLandingPath: orgHubPath(result.orgId) };
  }
  return { ...EMPTY_RESULT, kind: 'org', orgLandingPath: orgInvitePagePath(token), inviteError: ORG_REFUSAL_CODES[result.reason] };
}

/**
 * Hash the token once, look it up across all three pending-invite tables in
 * parallel, then dispatch to the matching surface's pipe. At most one
 * repository will return a row (token hashes are universally unique across
 * tables thanks to per-table UNIQUE indices and the same `ps_invite_*`
 * generator) — so the dispatch arm is unambiguous.
 */
export const consumeAnyInviteIfPresent = async ({
  request,
  inviteToken,
  user,
  isNewUser,
  email,
}: NativeInviteAcceptanceInput): Promise<NativeInviteAcceptanceResult> => {
  if (!inviteToken) return EMPTY_RESULT;

  try {
    const tokenHash = hashToken(inviteToken);

    const [driveRow, pageRow, connectionRow, orgInvite] = await Promise.all([
      driveInviteRepository.findPendingInviteByTokenHash(tokenHash),
      pageInviteRepository.findPendingInviteByTokenHash(tokenHash),
      connectionInviteRepository.findPendingInviteByTokenHash(tokenHash),
      findInvitationByToken(inviteToken),
    ]);

    // ORG-3: acceptInvitation is the whole decision (address, expiry, lapse), in its own transaction.
    if (orgInvite) return await consumeOrgInvite(request, inviteToken, user.id);

    const acceptInput = {
      token: inviteToken,
      userId: user.id,
      userEmail: email.toLowerCase(),
      // New users have no suspendedAt to honor — and reading suspendedAt
      // from a row created moments ago is a footgun (would block legitimate
      // signup-and-accept).
      suspendedAt: isNewUser ? null : user.suspendedAt,
      now: new Date(),
    };

    if (driveRow) {
      const ports = {
        ...buildAcceptancePorts(request),
        loadInvite: async () => ({
          id: driveRow.id,
          email: driveRow.email,
          driveId: driveRow.driveId,
          driveName: driveRow.driveName,
          role: driveRow.role,
          customRoleId: driveRow.customRoleId,
          invitedBy: driveRow.invitedBy,
          expiresAt: driveRow.expiresAt,
          consumedAt: driveRow.consumedAt,
        }),
      };
      const result = isNewUser
        ? await acceptInviteForNewUser(ports)(acceptInput)
        : await acceptInviteForExistingUser(ports)(acceptInput);
      if (result.ok) {
        return { ...EMPTY_RESULT, kind: 'drive', invitedDriveId: result.data.driveId };
      }
      return { ...EMPTY_RESULT, inviteError: result.error };
    }

    if (pageRow) {
      const ports = {
        ...buildPageAcceptancePorts(request),
        loadInvite: async () => pageRow,
      };
      const result = isNewUser
        ? await acceptPageInviteForNewUser(ports)(acceptInput)
        : await acceptPageInviteForExistingUser(ports)(acceptInput);
      if (result.ok) {
        return { ...EMPTY_RESULT, kind: 'page', invitedDriveId: result.data.driveId, invitedPageId: result.data.pageId };
      }
      return { ...EMPTY_RESULT, inviteError: result.error };
    }

    if (connectionRow) {
      const ports = {
        ...buildConnectionAcceptancePorts(request),
        loadInvite: async () => connectionRow,
      };
      const result = isNewUser
        ? await acceptConnectionInviteForNewUser(ports)(acceptInput)
        : await acceptConnectionInviteForExistingUser(ports)(acceptInput);
      if (result.ok) {
        return { ...EMPTY_RESULT, kind: 'connection', connectionId: result.data.connectionId };
      }
      return { ...EMPTY_RESULT, inviteError: result.error };
    }

    return { ...EMPTY_RESULT, inviteError: 'TOKEN_NOT_FOUND' };
  } catch (error) {
    loggers.auth.error('Invite acceptance pipe threw', error as Error);
    return EMPTY_RESULT;
  }
};

export interface ConsumeAllInvitesForEmailResult {
  drivesAccepted: number;
  pagesAccepted: number;
  connectionsCreated: number;
}

/**
 * Post-signup multi-invite auto-accept. The pipes load invites by token
 * hash, but we have invite ids from the by-email index — we therefore go
 * around the pipe's `loadInvite` port and call the repository's
 * consume-and-write directly, then manually fan out side effects via the
 * shared `emit*AcceptanceSideEffects` helpers so the post-acceptance
 * notification + audit chain is identical to the explicit-token path.
 *
 * Suspended users skip the entire helper — same gate the pipes enforce
 * for the explicit-token path.
 */
export const consumeAllInvitesForEmail = async ({
  request,
  email,
  user,
  now,
}: {
  request: Request;
  email: string;
  user: { id: string; suspendedAt: Date | null };
  now: Date;
}): Promise<ConsumeAllInvitesForEmailResult> => {
  const normalizedEmail = email.trim().toLowerCase();
  const summary: ConsumeAllInvitesForEmailResult = {
    drivesAccepted: 0,
    pagesAccepted: 0,
    connectionsCreated: 0,
  };

  if (user.suspendedAt) return summary;

  try {
    const [driveInvites, pageInvites, connectionInvites] = await Promise.all([
      driveInviteRepository.findUnconsumedActiveInvitesByEmail(normalizedEmail, now),
      pageInviteRepository.findUnconsumedActiveInvitesByEmail(normalizedEmail, now),
      connectionInviteRepository.findUnconsumedActiveInvitesByEmail(normalizedEmail, now),
    ]);

    const drivePorts = buildAcceptancePorts(request);
    const pagePorts = buildPageAcceptancePorts(request);
    const connectionPorts = buildConnectionAcceptancePorts(request);

    for (const inviteRow of driveInvites) {
      try {
        const normalizedCustomRoleId = inviteRow.role === 'ADMIN' ? null : inviteRow.customRoleId;
        const consumed = await driveInviteRepository.consumeInviteAndCreateMembership({
          inviteId: inviteRow.id,
          driveId: inviteRow.driveId,
          userId: user.id,
          role: inviteRow.role,
          customRoleId: normalizedCustomRoleId,
          invitedBy: inviteRow.invitedBy,
          acceptedAt: now,
        });
        if (!consumed.ok) continue;

        const data: AcceptedInviteData = {
          inviteId: inviteRow.id,
          inviteEmail: normalizedEmail,
          memberId: consumed.memberId,
          driveId: inviteRow.driveId,
          driveName: inviteRow.driveName,
          role: inviteRow.role,
          customRoleId: normalizedCustomRoleId,
          invitedUserId: user.id,
          inviterUserId: inviteRow.invitedBy,
        };
        await emitAcceptanceSideEffects(drivePorts, data);
        summary.drivesAccepted += 1;
      } catch (error) {
        loggers.auth.warn('Auto-accept of drive invite failed during multi-invite resolution', {
          inviteId: inviteRow.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const inviteRow of pageInvites) {
      try {
        const consumed = await pageInviteRepository.consumeInviteAndGrantPage({
          inviteId: inviteRow.id,
          pageId: inviteRow.pageId,
          driveId: inviteRow.driveId,
          userId: user.id,
          permissions: inviteRow.permissions,
          invitedBy: inviteRow.invitedBy,
          grantedAt: now,
        });
        if (!consumed.ok) continue;

        const data: AcceptedPageInviteData = {
          inviteId: inviteRow.id,
          inviteEmail: normalizedEmail,
          pageId: inviteRow.pageId,
          pageTitle: inviteRow.pageTitle,
          driveId: inviteRow.driveId,
          driveName: inviteRow.driveName,
          permissions: inviteRow.permissions,
          memberId: consumed.memberId,
          invitedUserId: user.id,
          inviterUserId: inviteRow.invitedBy,
        };
        await emitPageAcceptanceSideEffects(pagePorts, data);
        summary.pagesAccepted += 1;
      } catch (error) {
        loggers.auth.warn('Auto-accept of page invite failed during multi-invite resolution', {
          inviteId: inviteRow.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const inviteRow of connectionInvites) {
      try {
        const consumed = await connectionInviteRepository.consumeInviteAndCreateConnection({
          inviteId: inviteRow.id,
          invitedBy: inviteRow.invitedBy,
          userId: user.id,
          requestMessage: inviteRow.requestMessage,
          now,
        });
        if (!consumed.ok) continue;

        const data: AcceptedConnectionData = {
          inviteId: inviteRow.id,
          inviteEmail: normalizedEmail,
          connectionId: consumed.connectionId,
          status: consumed.status,
          invitedUserId: user.id,
          inviterUserId: inviteRow.invitedBy,
        };
        await emitConnectionAcceptanceSideEffects(connectionPorts, data);
        summary.connectionsCreated += 1;
      } catch (error) {
        loggers.auth.warn('Auto-accept of connection invite failed during multi-invite resolution', {
          inviteId: inviteRow.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    loggers.auth.warn('consumeAllInvitesForEmail threw', {
      email: normalizedEmail,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return summary;
};

