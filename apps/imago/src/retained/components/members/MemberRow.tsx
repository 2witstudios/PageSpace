'use client';

import { GuestBadge, MemberSourceBadge } from './PageLinkGuestsSection';
import { Trash2 } from 'lucide-react';
import { Button } from '@/retained/components/ui/button';
import { Badge } from '@/retained/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/retained/components/ui/avatar';
import Link from '@/retained-adapters/link';

interface MemberRowProps {
  member: {
    source?: 'invite' | 'org' | 'lead';
    isGuest?: boolean;
    id: string;
    userId: string;
    role: string;
    invitedAt: string;
    acceptedAt: string | null;
    user: {
      id: string;
      email: string;
      name?: string;
    };
    profile?: {
      username?: string;
      displayName?: string;
      avatarUrl?: string;
    };
    customRole?: {
      id: string;
      name: string;
      color?: string | null;
    } | null;
    permissionCounts: {
      view: number;
      edit: number;
      share: number;
    };
  };
  orgLabels?: boolean;
  driveId: string;
  currentUserRole: 'OWNER' | 'ADMIN' | 'MEMBER';
  onRemove: () => void;
}

export function MemberRow({ member, driveId, orgLabels = false, currentUserRole, onRemove }: MemberRowProps) {
  const canManage = currentUserRole === 'OWNER' || currentUserRole === 'ADMIN';
  const displayName = member.profile?.displayName || member.user.name || member.user.email || 'Unknown User';
  const initials = displayName
    .split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  const getCustomRoleColorClasses = (color?: string | null) => {
    switch (color) {
      case 'blue':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300';
      case 'green':
        return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
      case 'yellow':
        return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300';
      case 'red':
        return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
      case 'purple':
        return 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300';
      case 'pink':
        return 'bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-300';
      case 'orange':
        return 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300';
      case 'cyan':
        return 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300';
      default:
        return 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300';
    }
  };

  const getRoleBadge = () => {
    if (member.role === 'OWNER') {
      return (
        <Badge className="bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300">
          Owner
        </Badge>
      );
    }
    if (member.role === 'ADMIN') {
      return (
        <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
          Admin
        </Badge>
      );
    }
    if (member.role === 'GUEST') {
      return (
        <Badge className="bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300">
          Guest
        </Badge>
      );
    }
    if (member.customRole) {
      return (
        <Badge className={getCustomRoleColorClasses(member.customRole.color)}>
          {member.customRole.name}
        </Badge>
      );
    }
    return (
      <Badge className="bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300">
        Member
      </Badge>
    );
  };

  const joined = new Date(member.acceptedAt ?? member.invitedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="p-4 flex items-center justify-between gap-4 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
      <Link
        href={`/dashboard/${driveId}/members/${member.userId}`}
        className="flex min-w-0 flex-1 items-center gap-4 no-underline"
        aria-label={`Open ${displayName}`}
      >
        <Avatar>
          <AvatarImage src={member.profile?.avatarUrl} alt={displayName} />
          <AvatarFallback>{initials}</AvatarFallback>
        </Avatar>

        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-medium truncate">{displayName}</p>
            {orgLabels && member.isGuest && member.role !== 'GUEST' && <GuestBadge />}
            {orgLabels && member.source && <MemberSourceBadge source={member.source} />}
            {member.profile?.username && (
              <span className="text-sm text-gray-500 dark:text-gray-400">@{member.profile.username}</span>
            )}
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-400 truncate">{member.user.email}</p>
        </div>
      </Link>

      <div className="flex items-center gap-3 flex-none">
        {getRoleBadge()}
        <span className="hidden sm:inline font-mono text-xs tabular-nums text-gray-500 dark:text-gray-400">
          Joined {joined}
        </span>
        {canManage && member.role !== 'OWNER' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onRemove}
            className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
            aria-label={`Remove ${displayName}`}
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
