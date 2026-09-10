'use client';

import { useEffect } from 'react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * The drive focus of a dashboard route.
 *
 * Every section that exists both for one drive and across all of them —
 * channels, files, tasks, calendar — is one page whose data is filtered by
 * this value. "All drives" is a focus like any drive, not a different page.
 *
 * The grammar lives here; the sidebar's navigation and the picker both
 * build their hrefs from it. The URL keeps its two shapes
 * (`/dashboard/<section>` and `/dashboard/[driveId]/<section>`): a missing
 * `driveId` param IS the All drives focus, which is what every `useParams`
 * reader in the app already assumes.
 */
export type Focus = { kind: 'all' } | { kind: 'drive'; driveId: string };

export const ALL_DRIVES: Focus = { kind: 'all' };

export function driveFocus(driveId: string): Focus {
  return { kind: 'drive', driveId };
}

export function focusDriveId(focus: Focus): string | undefined {
  return focus.kind === 'drive' ? focus.driveId : undefined;
}

/**
 * Every section that exists in both focuses. Agents, activity and trash
 * have a drive shape and a global one too (with different bodies), and a
 * focus change must keep them just like the four the sidebar's primary
 * navigation shows.
 */
export type FocusSection = 'channels' | 'files' | 'tasks' | 'calendar' | 'agents' | 'activity' | 'trash';

const SECTIONS: readonly FocusSection[] = ['channels', 'files', 'tasks', 'calendar', 'agents', 'activity', 'trash'];

const isSection = (value: string | undefined): value is FocusSection =>
  SECTIONS.includes(value as FocusSection);

/**
 * Files has no cross-drive listing of its own, so the drives browser is
 * what Files shows in the All drives focus — the same mapping the sidebar's
 * primary navigation uses.
 */
const ALL_DRIVES_SECTION_HREF: Record<FocusSection, string> = {
  channels: '/dashboard/channels',
  files: '/dashboard/drives',
  tasks: '/dashboard/tasks',
  calendar: '/dashboard/calendar',
  agents: '/dashboard/agents',
  activity: '/dashboard/activity',
  trash: '/dashboard/trash',
};

/**
 * Which section, if any, a pathname is showing. Recognises both shapes,
 * anything nested below a section (a files sub-folder, a channel), and
 * `/dashboard/drives` standing in for files.
 */
export function sectionForPathname(pathname: string | null | undefined): FocusSection | null {
  if (!pathname) return null;
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'dashboard' || segments.length < 2) return null;

  if (segments[1] === 'drives') return 'files';
  if (isSection(segments[1])) return 'files' === segments[1] ? null : segments[1];
  return isSection(segments[2]) ? segments[2] : null;
}

/** Where a section lives under a focus; with no section, the focus's home. */
export function focusSectionHref(focus: Focus, section: FocusSection | null): string {
  if (focus.kind === 'all') {
    return section ? ALL_DRIVES_SECTION_HREF[section] : '/dashboard';
  }
  return section ? `/dashboard/${focus.driveId}/${section}` : `/dashboard/${focus.driveId}`;
}

/**
 * Where changing focus from `pathname` should land: the same section under
 * the new focus when there is one, else that focus's home. A drive picked
 * while looking at files is wanted for its files.
 */
export function focusDestinationHref(pathname: string | null | undefined, focus: Focus): string {
  return focusSectionHref(focus, sectionForPathname(pathname));
}

/** Drive ids are cuid2; anything else is not a drive and must not become a path. */
export function isDriveIdShape(value: string): boolean {
  return /^[a-z0-9]+$/.test(value);
}

/**
 * Where a pre-focus bookmark `/dashboard/<section>?driveId=…` now lives:
 * the same section under that drive, with every other query parameter
 * carried across. Null when the URL carries no usable drive id.
 */
export function legacyFocusHref(pathname: string | null | undefined, searchParams: URLSearchParams): string | null {
  const driveId = searchParams.get('driveId');
  if (!driveId || !isDriveIdShape(driveId)) return null;
  const rest = new URLSearchParams(searchParams);
  rest.delete('driveId');
  const query = rest.toString();
  const href = focusSectionHref(driveFocus(driveId), sectionForPathname(pathname));
  return query ? `${href}?${query}` : href;
}

/**
 * Sends a pre-focus `?driveId=` bookmark to its drive route. Returns the
 * destination while the redirect is pending, so a page can render nothing
 * (and fetch nothing) on its way out; null when there is nothing to do.
 */
export function useLegacyFocusRedirect(enabled = true): string | null {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const href = enabled ? legacyFocusHref(pathname, searchParams) : null;
  useEffect(() => {
    if (href) router.replace(href);
  }, [href, router]);
  return href;
}

/**
 * The focus of the route being rendered. Reads the `[driveId]` segment, so
 * every static sibling of it (`/dashboard/tasks`, `/dashboard/dms`, …) is
 * All drives. Components take this rather than reading `useParams`
 * themselves, so "is a drive open" is asked in one place.
 */
export function useFocus(): Focus {
  const params = useParams<{ driveId?: string | string[] }>();
  const raw = params?.driveId;
  const driveId = Array.isArray(raw) ? raw[0] : raw;
  return driveId ? driveFocus(driveId) : ALL_DRIVES;
}
