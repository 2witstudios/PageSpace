'use client';

import useSWR from 'swr';
import { formatDistanceToNow } from 'date-fns';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { usePageNavigation } from '@/hooks/usePageNavigation';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { cn } from '@/lib/utils';
import { operationConfig, defaultOperationConfig } from '@/components/activity/constants';
import { getInitials } from '@/components/activity/utils';
import type { ActivityLog } from '@/components/activity/types';

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error('Failed to fetch activity');
  return response.json();
};

interface WhatsNewProps {
  driveId: string;
  limit?: number;
}

/**
 * "What's new" — a few recent activity lines for the current drive (who changed
 * what, when). Read-only; clicking a row with a page navigates to it. Hidden
 * when the drive has no activity yet.
 */
export function WhatsNew({ driveId, limit = 5 }: WhatsNewProps) {
  const { navigateToPage } = usePageNavigation();

  const { data, isLoading } = useSWR<{ activities: ActivityLog[] }>(
    `/api/activities?context=drive&driveId=${driveId}&limit=${limit}`,
    fetcher,
    { revalidateOnFocus: false }
  );

  if (isLoading) {
    return (
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          What&apos;s new
        </h3>
        <div className="space-y-1.5">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-7 w-full rounded-md" />
          ))}
        </div>
      </section>
    );
  }

  const activities = data?.activities ?? [];
  if (activities.length === 0) return null;

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        What&apos;s new
      </h3>
      <ul className="space-y-0.5">
        {activities.map((activity) => {
          const opConfig = operationConfig[activity.operation] || defaultOperationConfig;
          const actorName =
            activity.user?.name || activity.actorDisplayName || activity.actorEmail;
          const title = activity.resourceTitle || 'Untitled';
          const canNavigate = Boolean(activity.pageId);

          return (
            <li key={activity.id}>
              <button
                type="button"
                disabled={!canNavigate}
                onClick={
                  canNavigate
                    ? () => navigateToPage(activity.pageId as string, driveId)
                    : undefined
                }
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                  canNavigate
                    ? 'hover:bg-accent hover:text-accent-foreground cursor-pointer'
                    : 'cursor-default'
                )}
              >
                <Avatar className="size-5 shrink-0">
                  {activity.user?.image ? (
                    <AvatarImage src={activity.user.image} alt={actorName} />
                  ) : null}
                  <AvatarFallback className="text-[9px] font-medium">
                    {getInitials(activity.user?.name ?? null, activity.actorEmail)}
                  </AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  <span className="font-medium text-foreground">{actorName}</span>{' '}
                  {opConfig.label.toLowerCase()}{' '}
                  <span className="text-foreground">{title}</span>
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground/60">
                  {formatDistanceToNow(new Date(activity.timestamp), { addSuffix: true })}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
