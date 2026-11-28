/**
 * Resolve what an admin typed — a content hash, a file ID, a page ID, a
 * published URL or a user ID — to a takedown target, with the metadata the
 * console shows.
 *
 * Metadata only. Nothing here returns a title, a filename, a storage URL or
 * anything else that could display or lead to the file itself: admins must be
 * able to act on suspected CSAM without ever seeing it.
 */

import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { contentBlocks, type ContentBlockCategory, type ContentCaseTargetType } from '@pagespace/db/schema/content-safety';
import { drives, pages } from '@pagespace/db/schema/core';
import { publishedPages } from '@pagespace/db/schema/published-pages';
import { customDomains } from '@pagespace/db/schema/custom-domains';
import { files } from '@pagespace/db/schema/storage';
import { PUBLISH_HOST } from '../canvas/primary-host';
import { isDriveSiteHeld, resolvePrefixOwner } from '../organizations/published-visibility';
import { normalizeContentHash } from './policy';
import { collectContentReferences } from './references';
import type { ContentReferences } from './takedown';

export interface ResolvedTarget {
  targetType: ContentCaseTargetType;
  targetId: string;
  contentHash: string | null;
  /** Set when the hash is already on the blocklist. */
  block: { category: ContentBlockCategory; caseId: string | null; createdAt: string } | null;
  page: { id: string; driveId: string; type: string; mimeType: string | null; isPublished: boolean; isTrashed: boolean } | null;
  drive: { id: string; ownerId: string; orgId: string | null; publishes: boolean; sitesHeld: boolean } | null;
  /** `hasAvatar`: a profile image is set. `hasUploadedAvatar`: it is stored by us rather than an external URL. */
  user: { id: string; suspended: boolean; hasAvatar: boolean; hasUploadedAvatar: boolean } | null;
  /** Everything referencing the hash. Null when the target has no content hash. */
  references: ContentReferences | null;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ASSET_PATH = /^\/assets\/(?:cache\/)?([0-9a-f]{64})(?:\/|$)/i;
const STORAGE_KEY = /(?:files|cache|chat-attachments)\/([0-9a-f]{64})\//i;
const AVATAR_PATH = /\/api\/avatar\/([A-Za-z0-9_-]{1,64})\//;
const DASHBOARD_PATH = /^\/dashboard\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,64})/;

/** Legacy `files/<hash>/original` or a bare hash, as the file readers accept. */
function hashOfStoredReference(value: string | null | undefined): string | null {
  if (!value) return null;
  const legacy = value.match(/^files\/([a-f0-9]{64})\/original$/i);
  return normalizeContentHash(legacy ? legacy[1] : value);
}

/** A user's avatar lives in our storage only when `image` is a local path, not an external (OAuth provider) URL. */
export function isUploadedAvatar(image: string | null | undefined): boolean {
  return Boolean(image) && !/^https?:\/\//i.test(image as string);
}

/** The same normalisation `buildPublishedKey` applies to a request path. */
function publishedPathOf(pathname: string): string {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape is not a path we published; match it as typed.
  }
  return decoded
    .toLowerCase()
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..' && segment !== 'index.html')
    .join('/');
}

async function loadPage(pageId: string): Promise<{ page: NonNullable<ResolvedTarget['page']>; contentHash: string | null } | null> {
  const [row] = await db
    .select({
      id: pages.id,
      driveId: pages.driveId,
      type: pages.type,
      mimeType: pages.mimeType,
      filePath: pages.filePath,
      isTrashed: pages.isTrashed,
    })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1);
  if (!row) return null;
  const [published] = await db.select({ id: publishedPages.id }).from(publishedPages).where(eq(publishedPages.pageId, pageId)).limit(1);
  return {
    page: { id: row.id, driveId: row.driveId, type: row.type, mimeType: row.mimeType, isPublished: Boolean(published), isTrashed: row.isTrashed },
    contentHash: hashOfStoredReference(row.filePath),
  };
}

async function loadDrive(driveId: string): Promise<ResolvedTarget['drive']> {
  const [row] = await db
    .select({ id: drives.id, ownerId: drives.ownerId, orgId: drives.orgId, publishSubdomain: drives.publishSubdomain })
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);
  if (!row) return null;
  const [anyPublished] = await db.select({ id: publishedPages.id }).from(publishedPages).where(eq(publishedPages.driveId, driveId)).limit(1);
  return {
    id: row.id,
    ownerId: row.ownerId,
    orgId: row.orgId,
    publishes: Boolean(row.publishSubdomain) && Boolean(anyPublished),
    sitesHeld: await isDriveSiteHeld(driveId),
  };
}

async function loadUser(userId: string): Promise<ResolvedTarget['user']> {
  const [row] = await db
    .select({ id: users.id, suspendedAt: users.suspendedAt, image: users.image })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row
    ? { id: row.id, suspended: row.suspendedAt !== null, hasAvatar: Boolean(row.image), hasUploadedAvatar: isUploadedAvatar(row.image) }
    : null;
}

type Partial_ = Pick<ResolvedTarget, 'targetType' | 'targetId'> & Partial<Pick<ResolvedTarget, 'contentHash' | 'page' | 'drive' | 'user'>>;

async function finish(partial: Partial_): Promise<ResolvedTarget> {
  const contentHash = partial.contentHash ?? null;
  let block: ResolvedTarget['block'] = null;
  let references: ContentReferences | null = null;
  if (contentHash) {
    const [row] = await db.select().from(contentBlocks).where(eq(contentBlocks.contentHash, contentHash)).limit(1);
    if (row) block = { category: row.category, caseId: row.caseId, createdAt: row.createdAt.toISOString() };
    references = await collectContentReferences(contentHash);
  }
  const page = partial.page ?? null;
  const drive = partial.drive ?? (page ? await loadDrive(page.driveId) : null);
  return {
    targetType: partial.targetType,
    targetId: partial.targetId,
    contentHash,
    block,
    page,
    drive,
    user: partial.user ?? null,
    references,
  };
}

/**
 * The drive subdomain a host names, or null when it is not `<one label>.<publish host>`. Anywhere else
 * the first label is somebody else's text (`<a real subdomain>.evil.test`, `www.` on a custom domain), and
 * taking it as a subdomain would hand the admin another tenant's drive to act on.
 */
export function publishSubdomainOf(host: string): string | null {
  const suffix = `.${PUBLISH_HOST}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  return label.length > 0 && !label.includes('.') ? label : null;
}

async function resolveUrl(url: URL): Promise<ResolvedTarget | null> {
  const asset = url.pathname.match(ASSET_PATH) ?? url.pathname.match(STORAGE_KEY);
  if (asset) return finish({ targetType: 'content_hash', targetId: asset[1].toLowerCase(), contentHash: asset[1].toLowerCase() });

  const avatar = url.pathname.match(AVATAR_PATH);
  if (avatar) {
    const user = await loadUser(avatar[1]);
    return user ? finish({ targetType: 'avatar', targetId: user.id, user }) : null;
  }

  const dashboard = url.pathname.match(DASHBOARD_PATH);
  if (dashboard) {
    const loaded = await loadPage(dashboard[2]);
    if (loaded) return finish({ targetType: 'page', targetId: loaded.page.id, ...loaded });
  }

  // A published site: the host is a registered custom domain, or `<subdomain>.<publish host>`.
  const host = url.hostname.toLowerCase();
  const subdomain = publishSubdomainOf(host);
  const owner = subdomain !== null ? await resolvePrefixOwner(subdomain) : await resolvePrefixOwner(host);
  if (!owner) return null;
  const drive = await loadDrive(owner.driveId);
  if (!drive) return null;

  const path = publishedPathOf(url.pathname);
  let pageId: string | null = null;
  if (path === '') {
    // The root serves the drive's home page, unless a custom domain names its own landing page
    // (custom_domains.publishLandingPageId), which that domain serves at its root instead.
    const [landing] =
      subdomain === null
        ? await db.select({ pageId: customDomains.publishLandingPageId }).from(customDomains).where(eq(customDomains.hostname, host)).limit(1)
        : [];
    if (landing?.pageId) {
      pageId = landing.pageId;
    } else {
      const [row] = await db.select({ homePageId: drives.homePageId }).from(drives).where(eq(drives.id, drive.id)).limit(1);
      pageId = row?.homePageId ?? null;
    }
  } else {
    const [row] = await db
      .select({ pageId: publishedPages.pageId })
      .from(publishedPages)
      .where(and(eq(publishedPages.driveId, drive.id), eq(publishedPages.path, path)))
      .limit(1);
    pageId = row?.pageId ?? null;
  }
  const loaded = pageId ? await loadPage(pageId) : null;
  // The target is what the URL resolved to — its page, or failing that its drive.
  // The URL itself is never stored or returned: it is a link to the content.
  return loaded
    ? finish({ targetType: 'page', targetId: loaded.page.id, drive, ...loaded })
    : finish({ targetType: 'drive', targetId: drive.id, drive });
}

/**
 * Resolve the admin's input. Returns null when it matches nothing. Tried in
 * order: content hash, URL, then an ID looked up as a file, a page, a user and
 * a drive.
 */
export async function resolveTakedownTarget(input: string): Promise<ResolvedTarget | null> {
  const raw = input.trim();
  if (!raw) return null;

  const hash = normalizeContentHash(raw);
  if (hash) return finish({ targetType: 'content_hash', targetId: hash, contentHash: hash });

  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    return resolveUrl(url);
  }

  if (!ID_PATTERN.test(raw)) return null;

  const [file] = await db.select({ id: files.id, storagePath: files.storagePath }).from(files).where(eq(files.id, raw)).limit(1);
  if (file) return finish({ targetType: 'file', targetId: file.id, contentHash: hashOfStoredReference(file.storagePath || file.id) });

  const loaded = await loadPage(raw);
  if (loaded) return finish({ targetType: 'page', targetId: loaded.page.id, ...loaded });

  const user = await loadUser(raw);
  if (user) return finish({ targetType: 'user', targetId: user.id, user });

  const drive = await loadDrive(raw);
  if (drive) return finish({ targetType: 'drive', targetId: drive.id, drive });

  return null;
}
