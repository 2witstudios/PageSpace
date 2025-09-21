"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  HardDrive,
  File,
  Image,
  Video,
  FileText,
  Archive,
  Music,
  Sheet,
  Presentation,
  RefreshCw,
  AlertTriangle,
  ArrowLeft,
  TrendingUp,
  Clock,
  Database,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";

interface StorageInfo {
  quota: {
    userId: string;
    quotaBytes: number;
    usedBytes: number;
    availableBytes: number;
    utilizationPercent: number;
    tier: 'free' | 'pro' | 'business';
    warningLevel: 'none' | 'warning' | 'critical';
    formattedUsed: string;
    formattedQuota: string;
    formattedAvailable: string;
  };
  tierInfo: {
    name: string;
    quotaBytes: number;
    maxFileSize: number;
    maxConcurrentUploads: number;
    maxFileCount: number;
    features: string[];
  };
  fileCount: number;
  totalFiles: number;
  fileTypeBreakdown: Record<string, { count: number; totalSize: number }>;
  largestFiles: Array<{
    id: string;
    title: string;
    fileSize: number;
    mimeType: string;
    createdAt: string;
    driveId: string;
    formattedSize: string;
  }>;
  recentFiles: Array<{
    id: string;
    title: string;
    fileSize: number;
    mimeType: string;
    createdAt: string;
    driveId: string;
    formattedSize: string;
  }>;
  storageByDrive: Array<{
    driveId: string;
    driveName: string;
    fileCount: number;
    totalSize: number;
    formattedSize: string;
  }>;
}

const getFileIcon = (mimeType: string) => {
  if (!mimeType) return File;
  if (mimeType.startsWith('image/')) return Image;
  if (mimeType.startsWith('video/')) return Video;
  if (mimeType.startsWith('audio/')) return Music;
  if (mimeType.includes('pdf') || mimeType.startsWith('text/')) return FileText;
  if (mimeType.includes('sheet') || mimeType.includes('excel')) return Sheet;
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return Presentation;
  if (mimeType.includes('zip') || mimeType.includes('compress')) return Archive;
  return File;
};

const formatBytes = (bytes: number): string => {
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${Math.round(bytes / Math.pow(1024, i) * 100) / 100} ${sizes[i]}`;
};

export default function StorageDashboard() {
  const router = useRouter();
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [reconciling, setReconciling] = useState(false);

  const fetchStorageInfo = async (reconcile = false) => {
    try {
      const url = reconcile ? '/api/storage/info?reconcile=true' : '/api/storage/info';
      const response = await fetch(url);
      if (!response.ok) throw new Error('Failed to fetch storage info');
      const data = await response.json();
      setStorageInfo(data);
      if (reconcile) {
        toast.success('Storage data reconciled successfully');
      }
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
      <div className="container mx-auto py-10 px-10">
        <div className="space-y-6">
          <Skeleton className="h-8 w-48" />
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            <Skeleton className="h-48" />
            <Skeleton className="h-48" />
            <Skeleton className="h-48" />
          </div>
        </div>
      </div>
    );
  }

  if (!storageInfo) {
    return (
      <div className="container mx-auto py-10 px-10">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>Failed to load storage information. Please try again.</AlertDescription>
        </Alert>
      </div>
    );
  }

  const { quota, tierInfo, fileTypeBreakdown, largestFiles, recentFiles, storageByDrive, totalFiles } = storageInfo;

  return (
    <div className="h-full overflow-y-auto">
      <div className="container mx-auto py-10 px-10">
        <div className="mb-8">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/dashboard')}
          className="mb-4"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Dashboard
        </Button>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold mb-2">Storage Dashboard</h1>
            <p className="text-muted-foreground">
              Monitor your storage usage and manage your files
            </p>
          </div>
          <Button
            onClick={handleReconcile}
            disabled={reconciling}
            variant="outline"
            size="sm"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${reconciling ? 'animate-spin' : ''}`} />
            Reconcile Storage
          </Button>
        </div>
      </div>

      {/* Warning Alert */}
      {quota.warningLevel !== 'none' && (
        <Alert variant={quota.warningLevel === 'critical' ? 'destructive' : 'default'} className="mb-6">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>
            {quota.warningLevel === 'critical' ? 'Critical Storage Warning' : 'Storage Warning'}
          </AlertTitle>
          <AlertDescription>
            You have used {Math.round(quota.utilizationPercent)}% of your storage quota.
            {quota.warningLevel === 'critical' && ' Consider deleting some files or upgrading your plan.'}
          </AlertDescription>
        </Alert>
      )}

      {/* Overview Cards */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 mb-8">
        {/* Storage Usage Card */}
        <Card className="col-span-full lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HardDrive className="h-5 w-5" />
              Storage Usage
            </CardTitle>
            <CardDescription>
              {quota.formattedUsed} of {quota.formattedQuota} used
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Progress
              value={quota.utilizationPercent}
              className="h-3"
            />
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">
                {quota.formattedAvailable} available
              </span>
              <span className="font-medium">
                {Math.round(quota.utilizationPercent)}%
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Tier Information Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Storage Plan</span>
              <Badge variant="secondary" className="text-xs">
                {tierInfo.name}
              </Badge>
            </CardTitle>
            <CardDescription>Current limits and features</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Total Files:</span>
                <span className="font-medium">
                  {totalFiles}
                  {tierInfo.maxFileCount > 0 && ` / ${tierInfo.maxFileCount}`}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Max File Size:</span>
                <span className="font-medium">{formatBytes(tierInfo.maxFileSize)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Concurrent Uploads:</span>
                <span className="font-medium">{tierInfo.maxConcurrentUploads}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* File Type Breakdown */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            Storage Breakdown by Type
          </CardTitle>
          <CardDescription>Distribution of your files by category</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {Object.entries(fileTypeBreakdown).map(([type, data]) => (
              <div key={type} className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{type}</span>
                  <Badge variant="outline">{data.count}</Badge>
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatBytes(data.totalSize)}
                </div>
                <Progress
                  value={(data.totalSize / quota.usedBytes) * 100}
                  className="h-2"
                />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Storage by Drive */}
      {storageByDrive && storageByDrive.length > 0 && (
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-5 w-5" />
              Storage by Drive
            </CardTitle>
            <CardDescription>Storage usage across your drives</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Drive Name</TableHead>
                  <TableHead className="text-right">Files</TableHead>
                  <TableHead className="text-right">Storage Used</TableHead>
                  <TableHead className="text-right">Percentage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {storageByDrive.map((drive) => (
                  <TableRow key={drive.driveId}>
                    <TableCell className="font-medium">{drive.driveName}</TableCell>
                    <TableCell className="text-right">{drive.fileCount}</TableCell>
                    <TableCell className="text-right">{drive.formattedSize}</TableCell>
                    <TableCell className="text-right">
                      {Math.round((drive.totalSize / quota.usedBytes) * 100)}%
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-8 lg:grid-cols-2">
        {/* Recent Files */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              Recent Uploads
            </CardTitle>
            <CardDescription>Your most recently uploaded files</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {recentFiles.length === 0 ? (
                <p className="text-sm text-muted-foreground">No recent files</p>
              ) : (
                recentFiles.map((file) => {
                  const FileIconComponent = getFileIcon(file.mimeType);
                  return (
                    <div key={file.id} className="flex items-center justify-between py-2">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <FileIconComponent className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="text-sm truncate">{file.title}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>{file.formattedSize}</span>
                        <span>{formatDistanceToNow(new Date(file.createdAt), { addSuffix: true })}</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </CardContent>
        </Card>

        {/* Largest Files */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HardDrive className="h-5 w-5" />
              Largest Files
            </CardTitle>
            <CardDescription>Files consuming the most storage</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {largestFiles.length === 0 ? (
                <p className="text-sm text-muted-foreground">No files found</p>
              ) : (
                largestFiles.map((file, index) => {
                  const FileIconComponent = getFileIcon(file.mimeType);
                  return (
                    <div key={file.id} className="flex items-center justify-between py-2">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <span className="text-xs text-muted-foreground w-4">{index + 1}.</span>
                        <FileIconComponent className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="text-sm truncate">{file.title}</span>
                      </div>
                      <Badge variant="secondary" className="text-xs">
                        {file.formattedSize}
                      </Badge>
                    </div>
                  );
                })
              )}
            </div>
          </CardContent>
        </Card>
      </div>
      </div>
    </div>
  );
}