'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Smartphone, Monitor, Laptop, Trash2, Shield, ChevronDown, ChevronUp } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import type { Device } from '@/hooks/useDevices';
import { useState } from 'react';

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
    return <Badge className="bg-green-500 hover:bg-green-600">Trusted</Badge>;
  } else if (score >= 0.5) {
    return <Badge variant="secondary">Warning</Badge>;
  } else {
    return <Badge variant="destructive">Suspicious</Badge>;
  }
}

interface DeviceCardProps {
  device: Device;
  onRevoke: (device: Device) => void;
}

export function DeviceCard({ device, onRevoke }: DeviceCardProps) {
  const [showDetails, setShowDetails] = useState(false);
  const Icon = platformIcons[device.platform] || Monitor;

  const deviceDisplayName = device.deviceName || `Unknown ${platformLabels[device.platform]}`;
  const locationDisplay = device.location || device.lastIpAddress || device.ipAddress || 'Unknown location';

  return (
    <Card className={device.isCurrent ? 'border-primary' : ''}>
      <CardContent className="pt-6">
        <div className="flex items-start justify-between">
          <div className="flex gap-3 flex-1">
            <div className="flex-shrink-0">
              <Icon className="h-10 w-10 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <h4 className="font-medium truncate">{deviceDisplayName}</h4>
                <Badge variant="outline">{platformLabels[device.platform]}</Badge>
                {device.isCurrent && (
                  <Badge variant="default" className="bg-green-500 hover:bg-green-600">
                    Current Device
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground truncate">{locationDisplay}</p>
              <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground flex-wrap">
                <span>
                  Last active {formatDistanceToNow(new Date(device.lastUsedAt), { addSuffix: true })}
                </span>
                <span className="hidden sm:inline">•</span>
                <div className="flex items-center gap-1">
                  <Shield className="h-3 w-3" />
                  {getTrustScoreBadge(device.trustScore)}
                </div>
              </div>

              {showDetails && (
                <div className="mt-4 space-y-2 text-sm border-t pt-3">
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
                      <span className="text-xs">
                        {new Date(device.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                    <div>
                      <span className="font-medium text-muted-foreground">Expires: </span>
                      <span className="text-xs">
                        {new Date(device.expiresAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                  {device.suspiciousActivityCount > 0 && (
                    <div>
                      <Badge variant="destructive" className="text-xs">
                        {device.suspiciousActivityCount} suspicious {device.suspiciousActivityCount === 1 ? 'event' : 'events'}
                      </Badge>
                    </div>
                  )}
                </div>
              )}

              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowDetails(!showDetails)}
                className="mt-2 h-7 text-xs"
              >
                {showDetails ? (
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
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRevoke(device)}
            className="text-destructive hover:text-destructive hover:bg-destructive/10 flex-shrink-0 ml-2"
            title="Revoke device access"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
