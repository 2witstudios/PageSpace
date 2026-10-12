'use client';

import useSWR from 'swr';
import { isPageTypeValue, type PageTypeValue } from '@pagespace/lib/utils/enums';

/** apps/web's recently viewed pages; enough rows that one drive still fills a short list. */
export const RECENTS = '/api/user/recents?limit=20';

export type RecentRow = {
  readonly id: string;
  readonly title: string;
  readonly type: PageTypeValue;
  readonly viewedAt: string;
};

/** This drive's recents from GET /api/user/recents, newest first (as the API orders them). */
export const recentsOf = (body: unknown, driveId: string, limit: number): readonly RecentRow[] => {
  if (typeof body !== 'object' || body === null) return [];
  const { recents } = body as { readonly recents?: unknown };
  if (!Array.isArray(recents)) return [];
  return recents
    .flatMap((row: unknown) => {
      if (typeof row !== 'object' || row === null) return [];
      const { id, title, type, driveId: owner, viewedAt } = row as Record<string, unknown>;
      return typeof id === 'string' && typeof title === 'string' && typeof type === 'string' && isPageTypeValue(type) &&
        owner === driveId && typeof viewedAt === 'string' && !Number.isNaN(Date.parse(viewedAt))
        ? [{ id, title, type, viewedAt }]
        : [];
    })
    .slice(0, limit);
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The boards' short age beside a recent: now, 5m, 1h, Yesterday, Oct 5. */
export const ageLabel = (iso: string, now: Date): string => {
  const at = new Date(iso);
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const sameDay = at.toDateString() === now.toDateString();
  if (sameDay) return `${Math.floor(minutes / 60)}h`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (at.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return `${MONTHS[at.getMonth()]} ${at.getDate()}`;
};

/** A page opens under Files in its drive; the Files route serves every page type. */
export const drivePageHref = (driveId: string, pageId: string): string =>
  `/${encodeURIComponent(driveId)}/files/${encodeURIComponent(pageId)}`;

/** This drive's recents, live with the API. */
export const useRecents = (driveId: string | null, limit: number): readonly RecentRow[] => {
  const { data } = useSWR<unknown>(driveId === null ? null : RECENTS);
  return driveId === null ? [] : recentsOf(data, driveId, limit);
};
