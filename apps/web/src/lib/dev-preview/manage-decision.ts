/**
 * WHO may switch a dev-server preview off or on — the one rule, pure, asked
 * by both status routes (to tell the client) and both action routes (to
 * enforce it). Reading a preview is drive-member; managing one is stricter:
 *
 *  - an ENVIRONMENT's preview is shared by everyone in the drive, so switching
 *    it is a management act — the drive OWNER/ADMIN bar every other env write
 *    (rename, rebuild, delete, the published app's stop/resume) enforces. That
 *    holds however the user REACHED it: a member acting from inside their
 *    session in the env is still switching the env's shared preview, so the
 *    session route must not be a way around the env route's bar.
 *  - a SESSION's own preview (an ephemeral session on its own sprite) is the
 *    session OWNER's — the end-session precedent: the person whose compute it
 *    is may always release it, and nobody else gets to flip it under them.
 *
 * This same bar governs APPROVING an unlisted port for sharing, which is the
 * strictest thing the action route does — it makes a port reachable by
 * everyone the preview is reachable by. So a plain drive member may VIEW an
 * env's approved preview and can never approve one; the person who agrees is
 * the person who could already stop it.
 */

import type { AuthResult } from '@/lib/auth';
import { isPrincipalDriveOwnerOrAdmin } from '@/lib/auth';
import type { DevPreviewHolderRef } from '@pagespace/lib/services/sandbox/preview/dev-preview-core';

export function decideDevPreviewManage({
  holder,
  userId,
  sessionOwnerId,
  isDriveOwnerOrAdmin,
}: {
  /** Whose preview it is (the env for an env-bound session). */
  holder: DevPreviewHolderRef;
  userId: string;
  /** The session's owner when the user came through a session; null for the env route. */
  sessionOwnerId: string | null;
  /** The drive owner/admin verdict for the holder's drive (`isPrincipalDriveOwnerOrAdmin`). */
  isDriveOwnerOrAdmin: boolean;
}): boolean {
  if (holder.kind === 'env') return isDriveOwnerOrAdmin;
  return sessionOwnerId !== null && sessionOwnerId === userId;
}

export type DevPreviewManageVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'env_manage_requires_owner_or_admin' | 'session_manage_requires_owner'; message: string };

/**
 * The same rule, asked the same way by every route — status routes to tell
 * the client (`canManage`), action routes to enforce it. Performs the drive
 * role lookup itself, and ONLY for an env holder (a session holder's rule
 * needs no drive read), so no route re-assembles the inputs or the denial
 * copy by hand.
 */
export async function canManageDevPreview(
  auth: AuthResult,
  { holder, sessionOwnerId, driveId }: { holder: DevPreviewHolderRef; sessionOwnerId: string | null; driveId: string | null },
): Promise<DevPreviewManageVerdict> {
  const isDriveOwnerOrAdmin = holder.kind === 'env' && driveId !== null ? await isPrincipalDriveOwnerOrAdmin(auth, driveId) : false;
  if (decideDevPreviewManage({ holder, userId: auth.userId, sessionOwnerId, isDriveOwnerOrAdmin })) return { allowed: true };
  return holder.kind === 'env'
    ? { allowed: false, reason: 'env_manage_requires_owner_or_admin', message: 'Only the drive owner or an admin can switch an environment preview' }
    : { allowed: false, reason: 'session_manage_requires_owner', message: 'Only the session owner can switch its preview' };
}
