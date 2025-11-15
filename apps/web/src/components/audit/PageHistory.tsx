'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { formatDistanceToNow, format } from 'date-fns';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  History,
  Bot,
  User,
  RotateCcw,
  Eye,
  Clock,
  FileText,
  AlertCircle,
  CheckCircle,
  GitCompare,
} from 'lucide-react';
import { toast } from 'sonner';
import { fetchWithAuth, post } from '@/lib/auth-fetch';
import { getCsrfToken } from '@/lib/csrf';

interface PageVersion {
  id: string;
  versionNumber: number;
  title: string;
  contentSize: number;
  isAiGenerated: boolean;
  changeSummary: string | null;
  changeType: string | null;
  createdAt: string;
  createdBy: {
    id: string;
    name: string;
    image: string | null;
  } | null;
  auditEvent: {
    actionType: string;
    description: string;
    reason: string | null;
  } | null;
}

interface PageHistoryResponse {
  pageId: string;
  versions: PageVersion[];
  total: number;
}

interface PageHistoryProps {
  pageId: string;
  trigger?: React.ReactNode;
  onVersionRestored?: () => void;
}

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error('Failed to fetch page history');
  }
  return response.json();
};

const getUserInitials = (name: string) => {
  return name
    .split(' ')
    .map(part => part.charAt(0))
    .join('')
    .toUpperCase()
    .slice(0, 2);
};

const formatBytes = (bytes: number) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
};

const getChangeTypeColor = (changeType: string | null) => {
  switch (changeType) {
    case 'MAJOR':
      return 'destructive';
    case 'MINOR':
      return 'default';
    case 'PATCH':
      return 'secondary';
    default:
      return 'outline';
  }
};

export function PageHistory({ pageId, trigger, onVersionRestored }: PageHistoryProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<PageVersion | null>(null);
  const [isRestoring, setIsRestoring] = useState(false);

  const { data, error, isLoading, mutate } = useSWR<PageHistoryResponse>(
    isOpen ? `/api/pages/${pageId}/versions?limit=100` : null,
    fetcher,
    {
      revalidateOnFocus: false,
    }
  );

  const handleRestoreClick = (version: PageVersion) => {
    setSelectedVersion(version);
    setRestoreDialogOpen(true);
  };

  const handleRestoreConfirm = async () => {
    if (!selectedVersion) return;

    setIsRestoring(true);
    try {
      const csrfToken = await getCsrfToken();
      const response = await post(
        `/api/pages/${pageId}/versions`,
        { versionNumber: selectedVersion.versionNumber },
        {
          headers: {
            'X-CSRF-Token': csrfToken,
          },
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to restore version');
      }

      toast.success(`Page restored to version ${selectedVersion.versionNumber}`);
      setRestoreDialogOpen(false);
      setSelectedVersion(null);
      mutate(); // Refresh the version list
      onVersionRestored?.();
    } catch (error) {
      console.error('Error restoring version:', error);
      toast.error(
        error instanceof Error ? error.message : 'Failed to restore version'
      );
    } finally {
      setIsRestoring(false);
    }
  };

  return (
    <>
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogTrigger asChild>
          {trigger || (
            <Button variant="outline" size="sm">
              <History className="h-4 w-4 mr-2" />
              View History
            </Button>
          )}
        </DialogTrigger>

        <DialogContent className="max-w-4xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="h-5 w-5" />
              Page Version History
            </DialogTitle>
            <DialogDescription>
              View and restore previous versions of this page
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-hidden">
            {error ? (
              <div className="flex items-center justify-center p-8 text-destructive">
                <AlertCircle className="h-5 w-5 mr-2" />
                Failed to load version history
              </div>
            ) : isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <Skeleton className="h-10 w-10 rounded-full" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="h-3 w-1/2" />
                    </div>
                  </div>
                ))}
              </div>
            ) : data?.versions.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-8 text-muted-foreground">
                <FileText className="h-12 w-12 mb-4 opacity-50" />
                <p>No version history available</p>
              </div>
            ) : (
              <ScrollArea className="h-[calc(80vh-200px)]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-20">Version</TableHead>
                      <TableHead>Title</TableHead>
                      <TableHead>Changed By</TableHead>
                      <TableHead>Change Type</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data?.versions.map((version) => (
                      <TableRow key={version.id}>
                        <TableCell className="font-mono text-sm">
                          <Badge variant="outline">v{version.versionNumber}</Badge>
                        </TableCell>

                        <TableCell>
                          <div>
                            <p className="font-medium">{version.title}</p>
                            {version.changeSummary && (
                              <p className="text-xs text-muted-foreground mt-1">
                                {version.changeSummary}
                              </p>
                            )}
                            {version.auditEvent?.reason && (
                              <p className="text-xs text-muted-foreground italic mt-1">
                                {version.auditEvent.reason}
                              </p>
                            )}
                          </div>
                        </TableCell>

                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Avatar className="h-8 w-8">
                              <AvatarImage
                                src={version.createdBy?.image || undefined}
                              />
                              <AvatarFallback>
                                {version.createdBy
                                  ? getUserInitials(version.createdBy.name)
                                  : 'AI'}
                              </AvatarFallback>
                            </Avatar>
                            <div>
                              <p className="text-sm font-medium">
                                {version.createdBy?.name || 'AI Assistant'}
                              </p>
                              {version.isAiGenerated && (
                                <Badge variant="secondary" className="text-xs">
                                  <Bot className="h-3 w-3 mr-1" />
                                  AI Generated
                                </Badge>
                              )}
                            </div>
                          </div>
                        </TableCell>

                        <TableCell>
                          {version.changeType && (
                            <Badge variant={getChangeTypeColor(version.changeType)}>
                              {version.changeType}
                            </Badge>
                          )}
                        </TableCell>

                        <TableCell>
                          <div className="flex flex-col gap-1">
                            <span className="text-sm">
                              {formatDistanceToNow(new Date(version.createdAt), {
                                addSuffix: true,
                              })}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {format(new Date(version.createdAt), 'MMM d, yyyy HH:mm')}
                            </span>
                          </div>
                        </TableCell>

                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleRestoreClick(version)}
                            >
                              <RotateCcw className="h-3.5 w-3.5 mr-1" />
                              Restore
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>
            )}
          </div>

          {data && data.versions.length > 0 && (
            <div className="border-t pt-4">
              <p className="text-sm text-muted-foreground">
                Total versions: {data.total}
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Restore Confirmation Dialog */}
      <AlertDialog open={restoreDialogOpen} onOpenChange={setRestoreDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-destructive" />
              Restore Page Version?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will restore the page to version {selectedVersion?.versionNumber}.
              The current version will be saved in the history, and this action can be
              undone by restoring to the current version later.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {selectedVersion && (
            <div className="bg-muted p-4 rounded-lg space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Version:</span>
                <span className="font-mono">v{selectedVersion.versionNumber}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Title:</span>
                <span className="font-medium">{selectedVersion.title}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Created by:</span>
                <span>{selectedVersion.createdBy?.name || 'AI Assistant'}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Date:</span>
                <span>
                  {format(new Date(selectedVersion.createdAt), 'MMM d, yyyy HH:mm')}
                </span>
              </div>
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRestoring}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRestoreConfirm}
              disabled={isRestoring}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isRestoring ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                  Restoring...
                </>
              ) : (
                <>
                  <RotateCcw className="h-4 w-4 mr-2" />
                  Restore Version
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
