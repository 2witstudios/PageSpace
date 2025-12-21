'use client';

import { formatDistanceToNow, format } from 'date-fns';
import { Bot, FileText } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { operationConfig, resourceTypeIcons, defaultOperationConfig } from './constants';
import { getInitials } from './utils';
import type { ActivityLog } from './types';

interface ActivityItemProps {
  activity: ActivityLog;
}

export function ActivityItem({ activity }: ActivityItemProps) {
  const opConfig = operationConfig[activity.operation] || defaultOperationConfig;
  const OpIcon = opConfig.icon;
  const ResourceIcon = resourceTypeIcons[activity.resourceType] || FileText;

  const actorName = activity.user?.name || activity.actorDisplayName || activity.actorEmail;
  const actorImage = activity.user?.image;

  return (
    <div className="flex items-start gap-4 py-4 border-b last:border-b-0">
      {/* Avatar */}
      <Avatar className="h-10 w-10 shrink-0">
        <AvatarImage src={actorImage || undefined} alt={actorName} />
        <AvatarFallback>{getInitials(activity.actorDisplayName, activity.actorEmail)}</AvatarFallback>
      </Avatar>

      {/* Content */}
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-sm">{actorName}</span>
          <Badge variant={opConfig.variant} className="text-xs">
            <OpIcon className="h-3 w-3 mr-1" />
            {opConfig.label}
          </Badge>
          {activity.isAiGenerated && (
            <Badge variant="outline" className="text-xs gap-1">
              <Bot className="h-3 w-3" />
              AI
              {activity.aiModel && <span className="text-muted-foreground">({activity.aiModel})</span>}
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ResourceIcon className="h-4 w-4 shrink-0" />
          <span className="truncate">
            {activity.resourceTitle || activity.resourceType}
          </span>
        </div>

        {/* Updated fields */}
        {activity.updatedFields && activity.updatedFields.length > 0 && (
          <div className="text-xs text-muted-foreground">
            Changed: {activity.updatedFields.join(', ')}
          </div>
        )}
      </div>

      {/* Timestamp */}
      <div className="text-xs text-muted-foreground shrink-0 text-right">
        <div>{format(new Date(activity.timestamp), 'h:mm a')}</div>
        <div className="text-muted-foreground/60">
          {formatDistanceToNow(new Date(activity.timestamp), { addSuffix: true })}
        </div>
      </div>
    </div>
  );
}
