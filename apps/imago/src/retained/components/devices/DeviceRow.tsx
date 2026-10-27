'use client';

import { useState } from 'react';
import { Button } from '@/retained/components/ui/button';
import { Badge } from '@/retained/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/retained/components/ui/collapsible';
import { Separator } from '@/retained/components/ui/separator';
import { Smartphone, Monitor, Laptop, Shield, ChevronDown, ChevronUp } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import type { Device } from '@/retained/hooks/useDevices';

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
    <div className="px-3.5 py-3">
      <div className="flex min-h-[52px] items-center gap-3">
        <Icon className="h-[18px] w-[18px] shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{deviceDisplayName}</span>
            {device.isCurrent && (
              <span
                className="inline-flex h-[22px] items-center rounded-full bg-green-500/10 px-2 text-xs font-medium text-green-700 dark:text-green-400"
              >
                This device
              </span>
            )}
          </div>
          <span className="text-xs text-muted-foreground">
            {platformLabels[device.platform]} · Last active{' '}
            {formatDistanceToNow(new Date(device.lastUsedAt), { addSuffix: true })} · {locationDisplay}
          </span>
        </div>
        {!device.isCurrent && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            aria-label={`Revoke ${deviceDisplayName}`}
            onClick={() => onRevoke(device)}
          >
            Revoke
          </Button>
        )}
      </div>

      <div className="mt-1 flex items-center gap-2 pl-[30px]">
        <Shield className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
        {getTrustScoreBadge(device.trustScore)}
      </div>

      {/* Expandable details section */}
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="mt-1 h-7 text-xs">
            {isOpen ? (
              <>
                <ChevronUp className="h-3 w-3 mr-1" />
                Hide details
              </>
            ) : (
              <>
                <ChevronDown className="h-3 w-3 mr-1" />
                Show details
              </>
            )}
          </Button>
        </CollapsibleTrigger>

        <CollapsibleContent className="pt-2">
          <Separator className="mb-3" />
          <div className="space-y-2 text-sm">
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
  );
}
