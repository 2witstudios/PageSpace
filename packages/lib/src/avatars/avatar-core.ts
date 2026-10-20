/**
 * An org's or a drive's avatar is an image uploaded to PageSpace and served by PageSpace, never a
 * URL on someone else's host (which every member's browser would fetch: a tracking pixel and an IP
 * leak). Pure: the one definition of where an avatar lives and what a stored value may be, for every
 * subject that has one. The database holds the same rule as a CHECK constraint per table
 * (organizations_avatar_url_chk, drives_avatar_url_chk).
 *
 * Every upload is its own file (avatar-<nonce>.<ext>), so a replacement is written beside the old
 * one, the stored path is switched, and only then is the old file removed: a reader never meets a
 * path whose file is gone, and two concurrent uploads each delete only the file they replaced.
 */

/** What can carry an avatar. Each subject has its own storage folder and its own serving route. */
export type AvatarSubject = 'org' | 'drive';

const AVATAR_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** The accepted upload types: raster images only (an SVG can carry script). */
export const AVATAR_MIME_TYPES: readonly string[] = Object.keys(AVATAR_EXTENSIONS);

export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

const NONCE_PATTERN = /^[a-z0-9]{1,32}$/;
const FILENAME_PATTERN = /^avatar-[a-z0-9]{1,32}\.(png|jpg|gif|webp)$/;

const STORAGE_FOLDERS: Readonly<Record<AvatarSubject, string>> = { org: 'org-avatars', drive: 'drive-avatars' };
const ROUTE_ROOTS: Readonly<Record<AvatarSubject, string>> = { org: '/api/orgs', drive: '/api/drives' };

/**
 * The stored file's name, from the image type and a fresh nonce (never the uploader's filename);
 * null for a type that is not accepted or a nonce that is not lowercase alphanumerics.
 */
export const avatarFilename = (mimeType: string, nonce: string): string | null => {
  const extension = AVATAR_EXTENSIONS[mimeType];
  return extension && NONCE_PATTERN.test(nonce) ? `avatar-${nonce}.${extension}` : null;
};

export const isAvatarFilename = (filename: string): boolean => FILENAME_PATTERN.test(filename);

/** The object key in storage: one folder per subject, so one org's or drive's files are never another's. */
export const avatarStorageKey = (subject: AvatarSubject, id: string, filename: string): string =>
  `${STORAGE_FOLDERS[subject]}/${id}/${filename}`;

/** The stored avatar value: the PageSpace route that serves the file. The file name changes per upload, so it never goes stale in a cache. */
export const avatarPath = (subject: AvatarSubject, id: string, filename: string): string =>
  `${ROUTE_ROOTS[subject]}/${id}/avatar/${filename}`;

/** The file a stored value names, when it is exactly this subject's own avatar path; otherwise null. */
export const avatarFilenameFromPath = (subject: AvatarSubject, id: string, value: string): string | null => {
  const prefix = `${ROUTE_ROOTS[subject]}/${id}/avatar/`;
  if (!value.startsWith(prefix)) return null;
  const filename = value.slice(prefix.length);
  return isAvatarFilename(filename) ? filename : null;
};

/** Whether a stored value is this subject's own avatar path, exactly as avatarPath builds it. */
export const isAvatarPath = (subject: AvatarSubject, id: string, value: string): boolean =>
  avatarFilenameFromPath(subject, id, value) !== null;

/**
 * The colors a drive's initial tile may sit on. A fixed palette rather than any hex, so every
 * choice holds in light and dark; each app maps a key to its own theme classes. The database
 * refuses any other value (drives_color_chk).
 */
export const MARK_COLORS = ['slate', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'violet', 'pink'] as const;
export type MarkColor = (typeof MARK_COLORS)[number];

export const isMarkColor = (value: unknown): value is MarkColor =>
  typeof value === 'string' && (MARK_COLORS as readonly string[]).includes(value);
