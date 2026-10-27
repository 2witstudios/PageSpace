import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import type { AuthResult } from '@/lib/auth';
import { canPrincipalViewPage, isPrincipalDriveMember } from '@/lib/auth/principal-permissions';
import { getPageBreadcrumbTrail } from '@/lib/pages/get-page-breadcrumb-trail';
import type { ContextRef } from '@/lib/ai/shared/buildContextRef';
import type { LocationContext } from '@/lib/ai/shared/chat-types';

export interface AccessDeniedDetails {
  routeType: 'page' | 'channel';
  pageId: string;
}

export interface DriveAccessDeniedDetails {
  routeType: 'drive';
  driveId: string;
}

type OnAccessDenied = (details: AccessDeniedDetails | DriveAccessDeniedDetails) => void;

async function resolvePageContext(
  auth: AuthResult,
  pageId: string,
  routeType: 'page' | 'channel',
  onAccessDenied: OnAccessDenied | undefined,
): Promise<LocationContext | null> {
  const canView = await canPrincipalViewPage(auth, pageId);
  if (!canView) {
    onAccessDenied?.({ routeType, pageId }); // never leak a page the caller cannot view into the AI prompt.
    return null;
  }

  const trail = await getPageBreadcrumbTrail(pageId);
  if (trail.length === 0) return null; // page gone / broken ancestor chain

  const current = trail[trail.length - 1];
  const titles = trail.map((p) => p.title);
  const currentDrive = current.drive;
  const slugPrefix = currentDrive?.slug ? `/${currentDrive.slug}` : '';

  return {
    currentPage: {
      id: current.id,
      title: current.title,
      type: current.type,
      path: `${slugPrefix}/${titles.join('/')}`,
    },
    currentDrive: currentDrive ? { id: currentDrive.id, name: currentDrive.name, slug: currentDrive.slug } : null,
    breadcrumbs: currentDrive ? [currentDrive.name, ...titles] : titles,
  };
}

async function resolveDriveContext(
  auth: AuthResult,
  driveId: string,
  onAccessDenied: OnAccessDenied | undefined,
): Promise<LocationContext | null> {
  const isMember = await isPrincipalDriveMember(auth, driveId);
  if (!isMember) {
    onAccessDenied?.({ routeType: 'drive', driveId }); // never leak a drive the caller isn't a member of.
    return null;
  }

  const [drive] = await db
    .select({ id: drives.id, name: drives.name, slug: drives.slug })
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);
  if (!drive) return null;

  return {
    currentPage: null,
    currentDrive: drive,
    breadcrumbs: [drive.name],
  };
}

/**
 * Server-side counterpart to `buildContextRef`: resolves the client's
 * synchronous route reference into the actual page/drive/breadcrumb data the
 * AI prompt needs — permission-checked here, at request time, because the
 * client's ref is a claim, not a fact. A contextRef pointing at a page/drive
 * the caller cannot view resolves to `null` (the AI simply gets no location
 * context for that turn) rather than surfacing an error or, worse, trusting
 * the client's claim the way the old `pageContext`/`locationContext` body
 * fields did.
 *
 * `onAccessDenied` fires only for an actual authorization denial (view/
 * membership check failed) — not for a benign miss (routeType 'dm'/'other',
 * a missing pageId/driveId, or a page that passed the view check but no
 * longer exists). Callers wire it to their route's `auditRequest`, matching
 * the audit trail every other authz denial in these routes already gets
 * (e.g. `checkMCPPageScope`'s `mcp_page_scope_denied`).
 */
export async function resolveRequestContext(
  auth: AuthResult,
  contextRef: ContextRef | undefined,
  onAccessDenied?: OnAccessDenied,
): Promise<LocationContext | null> {
  if (!contextRef) return null;

  switch (contextRef.routeType) {
    case 'page':
    case 'channel':
      return contextRef.pageId
        ? resolvePageContext(auth, contextRef.pageId, contextRef.routeType, onAccessDenied)
        : null;
    case 'drive':
      return contextRef.driveId ? resolveDriveContext(auth, contextRef.driveId, onAccessDenied) : null;
    default:
      // 'dm' and 'other' carry no page/drive context for the AI location prompt.
      return null;
  }
}
