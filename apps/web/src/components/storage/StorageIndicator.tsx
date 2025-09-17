'use client';

import React from 'react';
import { Progress } from '@/components/ui/progress';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import { formatBytes } from '@pagespace/lib/services/storage-limits';
import { AlertTriangle, HardDrive } from 'lucide-react';

interface StorageIndicatorProps {
  used: number;
  quota: number;
  tier?: 'free' | 'pro' | 'enterprise';
  showDetails?: boolean;
  className?: string;
  compact?: boolean;
}

export function StorageIndicator({
  used,
  quota,
  tier = 'free',
  showDetails = true,
  className,
  compact = false
}: StorageIndicatorProps) {
  const percentage = quota > 0 ? (used / quota) * 100 : 0;
  const remaining = Math.max(0, quota - used);
  const warningLevel = percentage >= 95 ? 'critical' : percentage >= 80 ? 'warning' : 'normal';

  if (compact) {
    return (
      <div className={cn("flex items-center gap-2", className)}>
        <HardDrive className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">
          {formatBytes(used)} / {formatBytes(quota)}
        </span>
        {warningLevel !== 'normal' && (
          <AlertTriangle
            className={cn(
              "h-4 w-4",
              warningLevel === 'critical' ? "text-red-500" : "text-yellow-500"
            )}
          />
        )}
      </div>
    );
  }

  return (
    <div className={cn("space-y-3", className)}>
      <div className="space-y-2">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2">
            <HardDrive className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">
              Storage {tier !== 'free' && `(${tier})`}
            </span>
          </div>
          <span className="text-sm text-muted-foreground">
            {formatBytes(used)} / {formatBytes(quota)}
          </span>
        </div>

        <Progress
          value={percentage}
          className={cn(
            "h-2",
            warningLevel === 'critical' && "[&>div]:bg-red-500",
            warningLevel === 'warning' && "[&>div]:bg-yellow-500"
          )}
        />

        {showDetails && (
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{percentage.toFixed(1)}% used</span>
            <span>{formatBytes(remaining)} available</span>
          </div>
        )}
      </div>

      {warningLevel !== 'normal' && (
        <Alert
          variant={warningLevel === 'critical' ? 'destructive' : 'default'}
          className="py-2"
        >
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="text-sm">
            {warningLevel === 'critical' ? (
              <>
                Storage almost full! You have less than 5% remaining.
                {tier === 'free' && ' Consider upgrading for more storage.'}
              </>
            ) : (
              <>
                Storage filling up. You have less than 20% remaining.
                {tier === 'free' && ' Consider managing your files or upgrading.'}
              </>
            )}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

interface StorageQuotaDetails {
  quota: {
    userId: string;
    quotaBytes: number;
    usedBytes: number;
    availableBytes: number;
    utilizationPercent: number;
    tier: 'free' | 'pro' | 'enterprise';
    warningLevel: 'none' | 'warning' | 'critical';
  };
  fileCount?: number;
  largestFiles?: Array<{
    id: string;
    title: string;
    fileSize: number;
    formattedSize: string;
  }>;
  fileTypeBreakdown?: Record<string, { count: number; totalSize: number }>;
}

export function DetailedStorageView({ data }: { data: StorageQuotaDetails }) {
  const { quota, fileCount, largestFiles, fileTypeBreakdown } = data;

  return (
    <div className="space-y-6">
      <StorageIndicator
        used={quota.usedBytes}
        quota={quota.quotaBytes}
        tier={quota.tier}
        showDetails={true}
      />

      {fileCount !== undefined && (
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Total Files</p>
            <p className="text-2xl font-semibold">{fileCount}</p>
          </div>
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Average Size</p>
            <p className="text-2xl font-semibold">
              {fileCount > 0 ? formatBytes(quota.usedBytes / fileCount) : '0 B'}
            </p>
          </div>
        </div>
      )}

      {fileTypeBreakdown && Object.keys(fileTypeBreakdown).length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Storage by Type</h4>
          <div className="space-y-2">
            {Object.entries(fileTypeBreakdown)
              .sort((a, b) => b[1].totalSize - a[1].totalSize)
              .map(([type, data]) => (
                <div key={type} className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    {type} ({data.count} files)
                  </span>
                  <span>{formatBytes(data.totalSize)}</span>
                </div>
              ))}
          </div>
        </div>
      )}

      {largestFiles && largestFiles.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Largest Files</h4>
          <div className="space-y-1">
            {largestFiles.slice(0, 5).map((file) => (
              <div key={file.id} className="flex justify-between text-sm">
                <span className="text-muted-foreground truncate max-w-[200px]">
                  {file.title}
                </span>
                <span>{file.formattedSize}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}