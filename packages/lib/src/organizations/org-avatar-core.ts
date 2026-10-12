/**
 * ORG-1: an org's avatar is an image uploaded to PageSpace and served by PageSpace, never a URL
 * on someone else's host (which every member's browser would fetch: a tracking pixel and an IP
 * leak). Pure: the one definition of where an org avatar lives and what a stored value may be.
 * The database holds the same rule as a CHECK constraint (organizations_avatar_url_chk).
 */

const AVATAR_FILENAMES: Readonly<Record<string, string>> = {
  'image/png': 'avatar.png',
  'image/jpeg': 'avatar.jpg',
  'image/jpg': 'avatar.jpg',
  'image/gif': 'avatar.gif',
  'image/webp': 'avatar.webp',
};

/** The accepted upload types: raster images only (an SVG can carry script). */
export const ORG_AVATAR_MIME_TYPES: readonly string[] = Object.keys(AVATAR_FILENAMES);

export const ORG_AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/** The stored file's name, from the image type (never the uploader's filename); null for a type that is not accepted. */
export const orgAvatarFilename = (mimeType: string): string | null => AVATAR_FILENAMES[mimeType] ?? null;

const FILENAME_PATTERN = /^avatar\.(png|jpg|gif|webp)$/;

export const isOrgAvatarFilename = (filename: string): boolean => FILENAME_PATTERN.test(filename);

/** The object key in storage: one folder per org, so replacing or deleting an org's avatar touches only its own files. */
export const orgAvatarStorageKey = (orgId: string, filename: string): string => `org-avatars/${orgId}/${filename}`;

/** The stored avatar value: the PageSpace route that serves the file, versioned so a new upload is not served from cache. */
export const orgAvatarPath = (orgId: string, filename: string, version: number): string =>
  `/api/orgs/${orgId}/avatar/${filename}?v=${version}`;

/** Whether a stored value is this org's own avatar path, exactly as orgAvatarPath builds it. */
export const isOrgAvatarPath = (orgId: string, value: string): boolean => {
  const prefix = `/api/orgs/${orgId}/avatar/`;
  if (!value.startsWith(prefix)) return false;
  const match = /^([^/?#]+)\?v=(\d+)$/.exec(value.slice(prefix.length));
  return match !== null && isOrgAvatarFilename(match[1]);
};
