'use client';

import { Trash2, Eye, Edit, Share, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import Link from 'next/link';

interface MemberRowProps {
  member: {
    id: string;
    userId: string;
    role: string;
    invitedAt: string;
    acceptedAt?: string;
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
  driveId: string;
  currentUserRole: 'OWNER' | 'ADMIN' | 'MEMBER';
  onRemove: () => void;
}

export function MemberRow({ member, driveId, currentUserRole, onRemove }: MemberRowProps) {
  const displayName = member.profile?.displayName || member.user.name || 'Unknown User';
  const initials = displayName
    .split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  // Get color classes for custom role badges
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

  // Unified role badge - shows role name based on priority:
  // Owner > Admin > Custom Role > Member (fallback)
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
    if (member.customRole) {
      return (
        <Badge className={getCustomRoleColorClasses(member.customRole.color)}>
          {member.customRole.name}
        </Badge>
      );
    }
    // Fallback for members without a custom role assigned
    return (
      <Badge className="bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300">
        Member
      </Badge>
    );
  };

  return (
    <div className="p-4 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
      <div className="flex items-center space-x-4">
        {/* Avatar */}
        <Avatar>
          <AvatarImage src={member.profile?.avatarUrl} alt={displayName} />
          <AvatarFallback>{initials}</AvatarFallback>
        </Avatar>

        {/* User Info */}
        <div>
          <div className="flex items-center space-x-2">
            <p className="font-medium">{displayName}</p>
            {member.profile?.username && (
              <span className="text-sm text-gray-500 dark:text-gray-400">@{member.profile.username}</span>
            )}
            {getRoleBadge()}
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-400">{member.user.email}</p>
          
          {/* Permission Summary */}
          <div className="flex items-center space-x-4 mt-1">
            {member.permissionCounts.view > 0 && (
              <div className="flex items-center space-x-1 text-xs text-gray-500 dark:text-gray-400">
                <Eye className="w-3 h-3" />
                <span>{member.permissionCounts.view} pages</span>
              </div>
            )}
            {member.permissionCounts.edit > 0 && (
              <div className="flex items-center space-x-1 text-xs text-gray-500 dark:text-gray-400">
                <Edit className="w-3 h-3" />
                <span>{member.permissionCounts.edit} pages</span>
              </div>
            )}
            {member.permissionCounts.share > 0 && (
              <div className="flex items-center space-x-1 text-xs text-gray-500 dark:text-gray-400">
                <Share className="w-3 h-3" />
                <span>{member.permissionCounts.share} pages</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center space-x-2">
        {(currentUserRole === 'OWNER' || currentUserRole === 'ADMIN') && (
          <Link href={`/dashboard/${driveId}/members/${member.userId}`}>
            <Button
              variant="ghost"
              size="sm"
              title="Member Settings"
            >
              <User className="w-4 h-4" />
            </Button>
          </Link>
        )}
        {(currentUserRole === 'OWNER' || currentUserRole === 'ADMIN') && member.role !== 'OWNER' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onRemove}
            className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
            title="Remove Member"
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        )}
      </div>
    </div>
  );
}