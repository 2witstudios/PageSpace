'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import { Smartphone, Monitor, Laptop, Trash2, Shield, ChevronDown, ChevronUp } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';
import type { Device } from '@/hooks/useDevices';

const platformIcons = {
  ios: Smartphone,
  android: Smartphone,
  web: Monitor,
  desktop: Laptop,
};

const platformLabels = {
  ios: 'iOS',
  android: 'Android',
  web: 'Web',
  desktop: 'Desktop',
};

function getTrustScoreBadge(score: number) {
  if (score >= 0.8) {
    return <Badge className="bg-green-500 hover:bg-green-600 text-xs">Trusted</Badge>;
  } else if (score >= 0.5) {
    return <Badge variant="secondary" className="text-xs">Warning</Badge>;
  } else {
    return <Badge variant="destructive" className="text-xs">Suspicious</Badge>;
  }
}

interface DeviceRowProps {
  device: Device;
  onRevoke: (device: Device) => void;
}

export function DeviceRow({ device, onRevoke }: DeviceRowProps) {
  const [isOpen, setIsOpen] = useState(false);
  const Icon = platformIcons[device.platform] || Monitor;

  const deviceDisplayName = device.deviceName || `Unknown ${platformLabels[device.platform]}`;
  const locationDisplay = device.location || device.lastIpAddress || device.ipAddress || 'Unknown location';

  return (
    <div
      className={cn(
        'relative transition-colors hover:bg-muted/50',
        device.isCurrent && 'bg-primary/5 border-l-4 border-l-primary pl-3'
      )}
    >
      <div className="p-4">
        {/* Main row content */}
        <div className="flex items-start gap-3">
          {/* Device icon */}
          <div className="flex-shrink-0 pt-1">
            <Icon className="h-10 w-10 text-muted-foreground" />
          </div>

          {/* Device info */}
          <div className="flex-1 min-w-0 space-y-2">
            {/* Name and badges row */}
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <h4 className="font-medium truncate">{deviceDisplayName}</h4>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <Badge variant="outline" className="text-xs">
                    {platformLabels[device.platform]}
                  </Badge>
                  {device.isCurrent && (
                    <Badge className="bg-green-500 hover:bg-green-600 text-xs">
                      Current Device
                    </Badge>
                  )}
                </div>
              </div>

              {/* Revoke button (desktop) */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onRevoke(device)}
                className="hidden sm:flex text-destructive hover:text-destructive hover:bg-destructive/10 flex-shrink-0"
                title="Revoke device access"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>

            {/* Location */}
            <p className="text-sm text-muted-foreground truncate">{locationDisplay}</p>

            {/* Metadata */}
            <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
              <span>
                Last active {formatDistanceToNow(new Date(device.lastUsedAt), { addSuffix: true })}
              </span>
              <span className="hidden sm:inline">•</span>
              <div className="flex items-center gap-1">
                <Shield className="h-3 w-3" />
                {getTrustScoreBadge(device.trustScore)}
              </div>
            </div>

            {/* Revoke button (mobile) */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onRevoke(device)}
              className="sm:hidden w-full text-destructive hover:text-destructive hover:bg-destructive/10 mt-2"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Revoke Access
            </Button>
          </div>
        </div>

        {/* Expandable details section */}
        <Collapsible open={isOpen} onOpenChange={setIsOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="mt-3 h-7 text-xs w-full sm:w-auto">
              {isOpen ? (
                <>
                  <ChevronUp className="h-3 w-3 mr-1" />
                  Hide Details
                </>
              ) : (
                <>
                  <ChevronDown className="h-3 w-3 mr-1" />
                  Show Details
                </>
              )}
            </Button>
          </CollapsibleTrigger>

          <CollapsibleContent className="pt-3">
            <Separator className="mb-3" />
            <div className="space-y-2 text-sm sm:pl-[52px]">
              {device.userAgent && (
                <div>
                  <span className="font-medium text-muted-foreground">User Agent: </span>
                  <span className="text-xs break-all">{device.userAgent}</span>
                </div>
              )}
              <div>
                <span className="font-medium text-muted-foreground">Device ID: </span>
                <span className="text-xs font-mono">{device.deviceId.slice(0, 16)}...</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <span className="font-medium text-muted-foreground">Created: </span>
                  <span className="text-xs">{new Date(device.createdAt).toLocaleDateString()}</span>
                </div>
                <div>
                  <span className="font-medium text-muted-foreground">Expires: </span>
                  <span className="text-xs">{new Date(device.expiresAt).toLocaleDateString()}</span>
                </div>
              </div>
              {device.suspiciousActivityCount > 0 && (
                <div>
                  <Badge variant="destructive" className="text-xs">
                    {device.suspiciousActivityCount} suspicious{' '}
                    {device.suspiciousActivityCount === 1 ? 'event' : 'events'}
                  </Badge>
                </div>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  );
}
