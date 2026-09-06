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
 */

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
