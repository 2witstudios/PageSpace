'use client';

import { useMemo } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { usePresenceStore } from '@/stores/usePresenceStore';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { PresenceViewer } from '@/lib/websocket';

function getInitials(name: string): string {
  return name
    .split(' ')
    .filter((n) => n.length > 0)
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

// Deterministic color from userId for consistent avatar colors
const PRESENCE_COLORS = [
  'ring-blue-500',
  'ring-emerald-500',
  'ring-violet-500',
  'ring-amber-500',
  'ring-rose-500',
  'ring-cyan-500',
  'ring-pink-500',
  'ring-teal-500',
];

function getPresenceColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0;
  }
  return PRESENCE_COLORS[Math.abs(hash) % PRESENCE_COLORS.length];
}

interface PageViewersProps {
  pageId: string | null | undefined;
  /** Maximum number of avatars to show before "+N" counter */
  maxVisible?: number;
  /** Size variant */
  size?: 'sm' | 'md';
}

/**
 * Stacked avatar display showing who is currently viewing a page.
 * Excludes the current user from the display (like Notion).
 */
export function PageViewers({ pageId, maxVisible = 4, size = 'md' }: PageViewersProps) {
  const { user } = useAuth();
  const pageViewers = usePresenceStore((state) =>
    pageId ? state.pageViewers.get(pageId) : undefined
  );

  // Filter out current user
  const otherViewers = useMemo(() => {
    if (!pageViewers || !user?.id) return [];
    return pageViewers.filter((v) => v.userId !== user.id);
  }, [pageViewers, user?.id]);

  if (otherViewers.length === 0) return null;

  const visible = otherViewers.slice(0, maxVisible);
  const overflow = otherViewers.length - maxVisible;

  const sizeClasses = size === 'sm'
    ? { avatar: 'size-5', text: 'text-[9px]', overlap: '-ml-1.5', ring: 'ring-1', counter: 'size-5 text-[9px]' }
    : { avatar: 'size-6', text: 'text-[10px]', overlap: '-ml-2', ring: 'ring-2', counter: 'size-6 text-[10px]' };

  return (
    <div className="flex items-center" role="group" aria-label="People viewing this page">
      {visible.map((viewer) => (
        <ViewerAvatar
          key={viewer.userId}
          viewer={viewer}
          sizeClasses={sizeClasses}
        />
      ))}
      {overflow > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={cn(
                'relative flex items-center justify-center rounded-full bg-muted ring-background font-medium text-muted-foreground cursor-default',
                sizeClasses.counter,
                sizeClasses.overlap,
                sizeClasses.ring,
              )}
            >
              +{overflow}
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <div className="flex flex-col gap-0.5">
              {otherViewers.slice(maxVisible).map((v) => (
                <span key={v.userId}>{v.name}</span>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function ViewerAvatar({
  viewer,
  sizeClasses,
}: {
  viewer: PresenceViewer;
  sizeClasses: { avatar: string; text: string; overlap: string; ring: string };
}) {
  const colorClass = getPresenceColor(viewer.userId);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Avatar
          className={cn(
            'relative ring-background cursor-default',
            sizeClasses.avatar,
            sizeClasses.overlap,
            sizeClasses.ring,
            colorClass,
            'first:ml-0',
          )}
        >
          {viewer.avatarUrl ? (
            <AvatarImage src={viewer.avatarUrl} alt={viewer.name} />
          ) : null}
          <AvatarFallback className={cn(sizeClasses.text, 'font-medium')}>
            {getInitials(viewer.name)}
          </AvatarFallback>
        </Avatar>
      </TooltipTrigger>
      <TooltipContent side="bottom">{viewer.name}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Compact inline version for use in the sidebar page tree.
 * Shows smaller avatars with a single shared tooltip listing all viewers.
 */
export function PageViewersInline({ pageId, maxVisible = 3 }: { pageId: string | null | undefined; maxVisible?: number }) {
  const { user } = useAuth();
  const pageViewers = usePresenceStore((state) =>
    pageId ? state.pageViewers.get(pageId) : undefined
  );

  const otherViewers = useMemo(() => {
    if (!pageViewers || !user?.id) return [];
    return pageViewers.filter((v) => v.userId !== user.id);
  }, [pageViewers, user?.id]);

  if (otherViewers.length === 0) return null;

  const visible = otherViewers.slice(0, maxVisible);
  const overflow = otherViewers.length - maxVisible;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center flex-shrink-0" aria-label={`${otherViewers.length} viewing`}>
          {visible.map((viewer) => (
            <Avatar
              key={viewer.userId}
              className={cn(
                'relative size-4 -ml-1 first:ml-0 ring-1 ring-background',
                getPresenceColor(viewer.userId),
              )}
            >
              {viewer.avatarUrl ? (
                <AvatarImage src={viewer.avatarUrl} alt={viewer.name} />
              ) : null}
              <AvatarFallback className="text-[7px] font-medium">
                {getInitials(viewer.name)}
              </AvatarFallback>
            </Avatar>
          ))}
          {overflow > 0 && (
            <div className="relative flex items-center justify-center size-4 -ml-1 rounded-full bg-muted ring-1 ring-background text-[7px] font-medium text-muted-foreground">
              +{overflow}
            </div>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="right">
        <div className="flex flex-col gap-0.5">
          {otherViewers.map((v) => (
            <span key={v.userId}>{v.name}</span>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
