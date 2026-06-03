'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { HardDrive, RefreshCw, AlertTriangle, TrendingUp, Clock, Database } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

interface StorageInfo {
  quota: {
    quotaBytes: number;
    usedBytes: number;
    availableBytes: number;
    utilizationPercent: number;
    tier: string;
    warningLevel: 'none' | 'warning' | 'critical';
    formattedUsed: string;
    formattedQuota: string;
    formattedAvailable: string;
  };
  tierInfo: {
    name: string;
    maxFileSize: number;
    maxConcurrentUploads: number;
    maxFileCount: number;
  };
  totalFiles: number;
  fileTypeBreakdown: Record<string, { count: number; totalSize: number }>;
  largestFiles: Array<{ id: string; title: string; mimeType: string; formattedSize: string }>;
  recentFiles: Array<{ id: string; title: string; mimeType: string; createdAt: string; formattedSize: string }>;
  storageByDrive: Array<{ driveId: string; driveName: string; fileCount: number; totalSize: number; formattedSize: string }>;
}

const formatBytes = (bytes: number): string => {
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${Math.round((bytes / Math.pow(1024, i)) * 100) / 100} ${sizes[i]}`;
};

/**
 * Storage usage section for the billing page (moved from the standalone
 * `/dashboard/storage` dashboard): quota bar, plan limits, file-type and per-drive
 * breakdowns, and recent/largest files. Backed by `/api/storage/info`.
 */
export function StorageUsageCard() {
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [reconciling, setReconciling] = useState(false);

  const fetchStorageInfo = async (reconcile = false) => {
    try {
      const url = reconcile ? '/api/storage/info?reconcile=true' : '/api/storage/info';
      const response = await fetchWithAuth(url);
      if (!response.ok) throw new Error('Failed to fetch storage info');
      const data = await response.json();
      setStorageInfo(data);
      if (reconcile) toast.success('Storage data reconciled successfully');
    } catch (error) {
      console.error('Error fetching storage info:', error);
      toast.error('Failed to load storage information');
    } finally {
      setLoading(false);
      setReconciling(false);
    }
  };

  useEffect(() => {
    fetchStorageInfo();
  }, []);

  const handleReconcile = () => {
    setReconciling(true);
    fetchStorageInfo(true);
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="h-5 w-5" />
            Storage
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!storageInfo) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="h-5 w-5" />
            Storage
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Could not load storage information. Please refresh and try again.
          </p>
        </CardContent>
      </Card>
    );
  }

  const { quota, tierInfo, fileTypeBreakdown, largestFiles, recentFiles, storageByDrive, totalFiles } = storageInfo;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <HardDrive className="h-5 w-5" />
              Storage
            </CardTitle>
            <CardDescription>
              {quota.formattedUsed} of {quota.formattedQuota} used
              <Badge variant="secondary" className="ml-2 text-xs">{tierInfo.name}</Badge>
            </CardDescription>
          </div>
          <Button onClick={handleReconcile} disabled={reconciling} variant="outline" size="sm">
            <RefreshCw className={`h-4 w-4 mr-2 ${reconciling ? 'animate-spin' : ''}`} />
            Reconcile
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {quota.warningLevel !== 'none' && (
          <Alert variant={quota.warningLevel === 'critical' ? 'destructive' : 'default'}>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>
              {quota.warningLevel === 'critical' ? 'Critical storage warning' : 'Storage warning'}
            </AlertTitle>
            <AlertDescription>
              You have used {Math.round(quota.utilizationPercent)}% of your storage quota.
              {quota.warningLevel === 'critical' && ' Consider deleting some files or upgrading your plan.'}
            </AlertDescription>
          </Alert>
        )}

        {/* Usage bar */}
        <div className="space-y-2">
          <Progress value={quota.utilizationPercent} className="h-3" />
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-muted-foreground">{quota.formattedAvailable} available</span>
            <span className="font-medium">{Math.round(quota.utilizationPercent)}%</span>
          </div>
        </div>

        {/* Plan limits */}
        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <Limit label="Files" value={`${totalFiles}${tierInfo.maxFileCount > 0 ? ` / ${tierInfo.maxFileCount}` : ''}`} />
          <Limit label="Max file size" value={formatBytes(tierInfo.maxFileSize)} />
          <Limit label="Concurrent uploads" value={`${tierInfo.maxConcurrentUploads}`} />
        </div>

        {/* By type */}
        {Object.keys(fileTypeBreakdown).length > 0 && (
          <Section icon={<TrendingUp className="h-4 w-4" />} title="By type">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {Object.entries(fileTypeBreakdown).map(([type, d]) => (
                <div key={type} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{type}</span>
                    <Badge variant="outline">{d.count}</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">{formatBytes(d.totalSize)}</div>
                  <Progress value={quota.usedBytes > 0 ? (d.totalSize / quota.usedBytes) * 100 : 0} className="h-2" />
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* By drive */}
        {storageByDrive.length > 0 && (
          <Section icon={<Database className="h-4 w-4" />} title="By drive">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Drive</TableHead>
                    <TableHead className="text-right">Files</TableHead>
                    <TableHead className="text-right">Used</TableHead>
                    <TableHead className="text-right">%</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {storageByDrive.map((drive) => (
                    <TableRow key={drive.driveId}>
                      <TableCell className="font-medium">{drive.driveName}</TableCell>
                      <TableCell className="text-right">{drive.fileCount}</TableCell>
                      <TableCell className="text-right">{drive.formattedSize}</TableCell>
                      <TableCell className="text-right">
                        {quota.usedBytes > 0 ? Math.round((drive.totalSize / quota.usedBytes) * 100) : 0}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Section>
        )}

        {/* Recent + largest */}
        <div className="grid gap-6 lg:grid-cols-2">
          <Section icon={<Clock className="h-4 w-4" />} title="Recent uploads">
            <FileList
              empty="No recent files"
              items={recentFiles.map((f) => ({
                id: f.id,
                title: f.title,
                meta: `${f.formattedSize} · ${formatDistanceToNow(new Date(f.createdAt), { addSuffix: true })}`,
              }))}
            />
          </Section>
          <Section icon={<HardDrive className="h-4 w-4" />} title="Largest files">
            <FileList
              empty="No files found"
              items={largestFiles.map((f) => ({ id: f.id, title: f.title, meta: f.formattedSize }))}
            />
          </Section>
        </div>
      </CardContent>
    </Card>
  );
}

function Limit({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-muted-foreground">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        {icon}
        {title}
      </h3>
      {children}
    </div>
  );
}

function FileList({ items, empty }: { items: Array<{ id: string; title: string; meta: string }>; empty: string }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="space-y-2">
      {items.map((file) => (
        <div key={file.id} className="flex items-center justify-between gap-2 text-sm">
          <span className="truncate">{file.title}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{file.meta}</span>
        </div>
      ))}
    </div>
  );
}
