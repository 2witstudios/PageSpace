/**
 * ORG-1: an org's avatar is an image uploaded to PageSpace and served by PageSpace, never a URL
 * on someone else's host. The rules are the shared avatar rules (avatars/avatar-core.ts) for the
 * 'org' subject; these names are kept for the org callers. The database holds the same rule as a
 * CHECK constraint (organizations_avatar_url_chk).
 */
import {
  AVATAR_MIME_TYPES,
  avatarFilename,
  avatarFilenameFromPath,
  avatarPath,
  isAvatarPath,
} from '../avatars/avatar-core';

/** The accepted upload types: raster images only (an SVG can carry script). */
export const ORG_AVATAR_MIME_TYPES: readonly string[] = AVATAR_MIME_TYPES;

export const orgAvatarFilename = avatarFilename;

export const orgAvatarPath = (orgId: string, filename: string): string => avatarPath('org', orgId, filename);

export const orgAvatarFilenameFromPath = (orgId: string, value: string): string | null =>
  avatarFilenameFromPath('org', orgId, value);

export const isOrgAvatarPath = (orgId: string, value: string): boolean => isAvatarPath('org', orgId, value);
