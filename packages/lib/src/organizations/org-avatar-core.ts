/**
 * ORG-1: an org's avatar is an image uploaded to PageSpace and served by PageSpace, never a URL
 * on someone else's host (which every member's browser would fetch: a tracking pixel and an IP
 * leak). Pure: the one definition of where an org avatar lives and what a stored value may be.
 * The database holds the same rule as a CHECK constraint (organizations_avatar_url_chk).
 *
 * Every upload is its own file (avatar-<nonce>.<ext>), so a replacement is written beside the old
 * one, the stored path is switched, and only then is the old file removed: a reader never meets a
 * path whose file is gone, and two concurrent uploads each delete only the file they replaced.
 */

const AVATAR_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** The accepted upload types: raster images only (an SVG can carry script). */
export const ORG_AVATAR_MIME_TYPES: readonly string[] = Object.keys(AVATAR_EXTENSIONS);

export const ORG_AVATAR_MAX_BYTES = 5 * 1024 * 1024;

const NONCE_PATTERN = /^[a-z0-9]{1,32}$/;
const FILENAME_PATTERN = /^avatar-[a-z0-9]{1,32}\.(png|jpg|gif|webp)$/;

/**
 * The stored file's name, from the image type and a fresh nonce (never the uploader's filename);
 * null for a type that is not accepted or a nonce that is not lowercase alphanumerics.
 */
export const orgAvatarFilename = (mimeType: string, nonce: string): string | null => {
  const extension = AVATAR_EXTENSIONS[mimeType];
  return extension && NONCE_PATTERN.test(nonce) ? `avatar-${nonce}.${extension}` : null;
};

export const isOrgAvatarFilename = (filename: string): boolean => FILENAME_PATTERN.test(filename);

/** The object key in storage: one folder per org, so an org's files are never another org's. */
export const orgAvatarStorageKey = (orgId: string, filename: string): string => `org-avatars/${orgId}/${filename}`;

/** The stored avatar value: the PageSpace route that serves the file. The file name changes per upload, so it never goes stale in a cache. */
export const orgAvatarPath = (orgId: string, filename: string): string => `/api/orgs/${orgId}/avatar/${filename}`;

/** The file a stored value names, when it is exactly this org's own avatar path; otherwise null. */
export const orgAvatarFilenameFromPath = (orgId: string, value: string): string | null => {
  const prefix = `/api/orgs/${orgId}/avatar/`;
  if (!value.startsWith(prefix)) return null;
  const filename = value.slice(prefix.length);
  return isOrgAvatarFilename(filename) ? filename : null;
};

/** Whether a stored value is this org's own avatar path, exactly as orgAvatarPath builds it. */
export const isOrgAvatarPath = (orgId: string, value: string): boolean => orgAvatarFilenameFromPath(orgId, value) !== null;
