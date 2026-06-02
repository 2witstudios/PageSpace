'use client';

import React, { memo } from 'react';
import { Users, Crown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

export interface MemberInfo {
  userId?: string;
  name?: string | null;
  displayName?: string | null;
  email?: string | null;
  role?: string | null;
  avatarUrl?: string | null;
  connectedSince?: string | null;
}

interface MemberListRendererProps {
  members: MemberInfo[];
  /** Header title — defaults to "Members". */
  title?: string;
  maxHeight?: number;
  className?: string;
}

const ROLE_BADGE: Record<string, string> = {
  OWNER: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  EDITOR: 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
  VIEWER: 'bg-muted text-muted-foreground',
};

const initials = (name?: string | null, email?: string | null): string => {
  const source = (name || email || '?').trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
};

const formatConnectedSince = (iso?: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(d);
};

/**
 * MemberListRenderer - Drive members (list_drive_members) and connected
 * collaborators (list_collaborators). Shows avatar, name, email and role.
 */
export const MemberListRenderer: React.FC<MemberListRendererProps> = memo(function MemberListRenderer({
  members,
  title = 'Members',
  maxHeight = 320,
  className,
}) {
  return (
    <div className={cn('rounded-lg border bg-card overflow-hidden my-2 shadow-sm', className)}>
      <div className="flex items-center justify-between px-3 py-2 bg-muted/30 border-b">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{title}</span>
        </div>
        <span className="text-xs text-muted-foreground">
          {members.length} {members.length === 1 ? 'person' : 'people'}
        </span>
      </div>

      <div className="bg-background overflow-auto divide-y divide-border" style={{ maxHeight: `${maxHeight}px` }}>
        {members.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-4">No one here yet</div>
        ) : (
          members.map((m, i) => {
            const label = m.displayName || m.name || m.email || 'Unknown';
            const role = (m.role ?? '').toUpperCase();
            const connected = formatConnectedSince(m.connectedSince);
            return (
              <div key={m.userId ?? i} className="flex items-center gap-3 px-3 py-2">
                <Avatar className="h-8 w-8 shrink-0">
                  <AvatarImage src={m.avatarUrl || undefined} alt={label} />
                  <AvatarFallback className="text-xs">
                    {initials(m.name ?? m.displayName, m.email)}
                  </AvatarFallback>
                </Avatar>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium truncate">{label}</span>
                    {role === 'OWNER' && <Crown className="h-3 w-3 text-amber-500 shrink-0" />}
                  </div>
                  {m.email && <div className="text-xs text-muted-foreground truncate">{m.email}</div>}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {connected && <span className="text-xs text-muted-foreground">since {connected}</span>}
                  {role && (
                    <span
                      className={cn(
                        'text-xs px-1.5 py-0.5 rounded capitalize',
                        ROLE_BADGE[role] ?? 'bg-muted text-muted-foreground'
                      )}
                    >
                      {role.toLowerCase()}
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
});
