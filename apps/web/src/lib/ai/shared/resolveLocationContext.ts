import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { parseTabPath, getStaticTabMeta } from '@/lib/tabs/tab-title';
import type { LocationContext } from './chat-types';

export interface DriveEntry {
  id: string;
  slug: string;
  name: string;
}

export interface ResolvedLocationContext {
  label: string | null;
  locationContext: LocationContext | null;
}

function resolveDrive(driveId: string | undefined, drives: DriveEntry[]) {
  if (!driveId) return null;
  const driveData = drives.find((d) => d.id === driveId);
  return driveData ? { id: driveData.id, slug: driveData.slug, name: driveData.name } : null;
}

async function fetchPageContext(
  pageId: string,
  currentDrive: { id: string; slug: string; name: string } | null,
) {
  try {
    // Breadcrumbs only need pageId, which is already known — fetch both
    // requests concurrently instead of serially (breadcrumbs used to only
    // start after the page fetch resolved, roughly doubling latency for no
    // reason since neither depends on the other's result).
    const [pageResponse, breadcrumbsResponse] = await Promise.all([
      fetchWithAuth(`/api/pages/${pageId}`),
      fetchWithAuth(`/api/pages/${pageId}/breadcrumbs`).catch(() => null),
    ]);
    if (!pageResponse.ok) return null;
    const pageData = (await pageResponse.json()) as { id: string; title: string; type: string };

    // Only prefix the drive slug when we actually have one — channel routes
    // resolve no drive, so a bare `/${slug}` would bake "/undefined/..." into
    // the path that gets sent to the AI.
    const slugPrefix = currentDrive?.slug ? `/${currentDrive.slug}` : '';
    let path = `${slugPrefix}/${pageData.title}`;
    if (breadcrumbsResponse?.ok) {
      try {
        const breadcrumbsData = (await breadcrumbsResponse.json()) as Array<{ title: string }>;
        const pathSegments = breadcrumbsData.map((crumb) => crumb.title);
        path = `${slugPrefix}/${pathSegments.join('/')}`;
      } catch {
        // Keep the simple path fallback.
      }
    }

    return {
      id: pageData.id,
      title: pageData.title,
      type: pageData.type,
      path,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the sidebar's location context fresh, from the given route/drives
 * snapshot — no component state involved. Callers that need this synced to
 * navigation should still run it from an effect (for UI display); callers
 * sending a message to the AI should call this directly at send time instead
 * of reading a possibly-stale effect-derived state value.
 *
 * Deliberately uncached: this runs on every send, including several sends in
 * a row on the same page, which does cost extra requests — but caching by
 * pathname would resurrect exactly the staleness this function exists to
 * eliminate (see feedback that led here) unless it also tracks drive-list
 * updates, page renames, etc. A few extra fast page/breadcrumb fetches is a
 * safer failure mode than a subtly stale cache.
 */
export async function resolveLocationContext(
  pathname: string,
  drives: DriveEntry[],
): Promise<ResolvedLocationContext> {
  const parsed = parseTabPath(pathname);

  let label: string | null = null;
  let currentPage: LocationContext['currentPage'] = null;
  let currentDrive: LocationContext['currentDrive'] = null;

  try {
    switch (parsed.type) {
      // Real page routes — fetch the page so the AI keeps page context.
      case 'page':
      case 'channel': {
        currentDrive = parsed.type === 'page' ? resolveDrive(parsed.driveId, drives) : null;
        if (parsed.pageId) {
          currentPage = await fetchPageContext(parsed.pageId, currentDrive);
        }
        label = currentPage?.title ?? null;
        break;
      }

      // A whole drive — use the drive name from the store.
      case 'drive': {
        currentDrive = resolveDrive(parsed.driveId, drives);
        label = currentDrive?.name ?? null;
        break;
      }

      // A specific DM — show the other person's name (DMs are not pages).
      case 'dm': {
        if (parsed.conversationId) {
          try {
            const res = await fetchWithAuth(`/api/messages/conversations/${parsed.conversationId}`);
            if (res.ok) {
              const data = (await res.json()) as {
                conversation?: { otherUser?: { displayName?: string | null; name?: string | null } };
              };
              const otherUser = data?.conversation?.otherUser;
              label = otherUser?.displayName || otherUser?.name || null;
            }
          } catch {
            // Fall through to the generic DM label below.
          }
        }
        if (!label) label = 'Direct Message';
        break;
      }

      // Everything else with a known static title (dms, channels, tasks,
      // calendar, files/drives, activity, drive-scoped variants, …).
      // 'unknown' routes have no meaningful label (getStaticTabMeta would
      // echo the raw path), so fall back to the generic prompt.
      default: {
        label = parsed.type === 'unknown' ? null : getStaticTabMeta(parsed)?.title ?? null;
        break;
      }
    }
  } catch {
    label = null;
  }

  const breadcrumbs: string[] = [];
  if (currentDrive) breadcrumbs.push(currentDrive.name);
  if (currentPage?.path) {
    breadcrumbs.push(...currentPage.path.split('/').filter(Boolean).slice(1));
  }

  return {
    label,
    locationContext: currentPage || currentDrive ? { currentPage, currentDrive, breadcrumbs } : null,
  };
}
