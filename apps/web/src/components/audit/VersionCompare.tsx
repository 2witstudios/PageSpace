'use client';

import { useState, useEffect } from 'react';
import { format } from 'date-fns';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  GitCompare,
  ArrowLeft,
  ArrowRight,
  Bot,
  User,
  RotateCcw,
  AlertCircle,
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { toast } from 'sonner';
import { fetchWithAuth, post } from '@/lib/auth-fetch';
import { getCsrfToken } from '@/lib/csrf';

interface PageVersion {
  id: string;
  versionNumber: number;
  title: string;
  content: string;
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
}

interface VersionCompareProps {
  pageId: string;
  versionId: string;
  isOpen: boolean;
  onClose: () => void;
  onRestore?: () => void;
}

const getUserInitials = (name: string) => {
  return name
    .split(' ')
    .map(part => part.charAt(0))
    .join('')
    .toUpperCase()
    .slice(0, 2);
};

// Simple diff function that highlights changes
const computeDiff = (oldText: string, newText: string) => {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const maxLines = Math.max(oldLines.length, newLines.length);
  const result: Array<{
    oldLine: string | null;
    newLine: string | null;
    type: 'same' | 'added' | 'removed' | 'modified';
  }> = [];

  for (let i = 0; i < maxLines; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];

    if (oldLine === newLine) {
      result.push({ oldLine, newLine, type: 'same' });
    } else if (oldLine === undefined) {
      result.push({ oldLine: null, newLine, type: 'added' });
    } else if (newLine === undefined) {
      result.push({ oldLine, newLine: null, type: 'removed' });
    } else {
      result.push({ oldLine, newLine, type: 'modified' });
    }
  }

  return result;
};

export function VersionCompare({
  pageId,
  versionId,
  isOpen,
  onClose,
  onRestore,
}: VersionCompareProps) {
  const [version, setVersion] = useState<PageVersion | null>(null);
  const [currentVersion, setCurrentVersion] = useState<PageVersion | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRestoring, setIsRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && versionId) {
      loadVersions();
    }
  }, [isOpen, versionId, pageId]);

  const loadVersions = async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Fetch the specific version
      const versionResponse = await fetchWithAuth(`/api/pages/${pageId}/versions/${versionId}`);
      if (!versionResponse.ok) {
        throw new Error('Failed to load version');
      }
      const versionData = await versionResponse.json();
      setVersion(versionData);

      // Fetch current page version
      const currentResponse = await fetchWithAuth(`/api/pages/${pageId}`);
      if (!currentResponse.ok) {
        throw new Error('Failed to load current page');
      }
      const currentData = await currentResponse.json();
      setCurrentVersion({
        id: currentData.id,
        versionNumber: 0, // Current version
        title: currentData.title,
        content: currentData.content,
        contentSize: currentData.content?.length || 0,
        isAiGenerated: false,
        changeSummary: null,
        changeType: null,
        createdAt: currentData.updatedAt,
        createdBy: null,
      });
    } catch (err) {
      console.error('Error loading versions:', err);
      setError(err instanceof Error ? err.message : 'Failed to load versions');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRestore = async () => {
    if (!version) return;

    setIsRestoring(true);
    try {
      const csrfToken = await getCsrfToken();
      const response = await post(
        `/api/pages/${pageId}/versions`,
        { versionNumber: version.versionNumber },
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

      toast.success(`Page restored to version ${version.versionNumber}`);
      onRestore?.();
      onClose();
    } catch (error) {
      console.error('Error restoring version:', error);
      toast.error(
        error instanceof Error ? error.message : 'Failed to restore version'
      );
    } finally {
      setIsRestoring(false);
    }
  };

  const diff = version && currentVersion
    ? computeDiff(version.content || '', currentVersion.content || '')
    : [];

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-7xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitCompare className="h-5 w-5" />
            Compare Versions
          </DialogTitle>
          <DialogDescription>
            Compare changes between versions to see what has changed
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <div className="flex items-center justify-center p-8 text-destructive">
            <AlertCircle className="h-5 w-5 mr-2" />
            {error}
          </div>
        ) : isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-20 w-full" />
            <div className="grid grid-cols-2 gap-4">
              <Skeleton className="h-96 w-full" />
              <Skeleton className="h-96 w-full" />
            </div>
          </div>
        ) : version && currentVersion ? (
          <div className="space-y-4">
            {/* Version Headers */}
            <div className="grid grid-cols-2 gap-4">
              {/* Selected Version */}
              <div className="border rounded-lg p-4 bg-muted/50">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant="outline">v{version.versionNumber}</Badge>
                      {version.isAiGenerated && (
                        <Badge variant="secondary">
                          <Bot className="h-3 w-3 mr-1" />
                          AI
                        </Badge>
                      )}
                    </div>
                    <h3 className="font-medium">{version.title}</h3>
                  </div>
                  <ArrowLeft className="h-5 w-5 text-muted-foreground" />
                </div>

                <div className="flex items-center gap-2 text-sm">
                  <Avatar className="h-8 w-8">
                    <AvatarImage src={version.createdBy?.image || undefined} />
                    <AvatarFallback>
                      {version.createdBy
                        ? getUserInitials(version.createdBy.name)
                        : 'AI'}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-medium">
                      {version.createdBy?.name || 'AI Assistant'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(version.createdAt), 'MMM d, yyyy HH:mm')}
                    </p>
                  </div>
                </div>

                {version.changeSummary && (
                  <p className="text-sm text-muted-foreground mt-2">
                    {version.changeSummary}
                  </p>
                )}
              </div>

              {/* Current Version */}
              <div className="border rounded-lg p-4 bg-muted/50">
                <div className="flex items-start justify-between mb-3">
                  <ArrowRight className="h-5 w-5 text-muted-foreground" />
                  <div className="text-right">
                    <div className="flex items-center justify-end gap-2 mb-1">
                      <Badge variant="default">Current</Badge>
                    </div>
                    <h3 className="font-medium">{currentVersion.title}</h3>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 text-sm">
                  <div className="text-right">
                    <p className="font-medium">Latest Version</p>
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(currentVersion.createdAt), 'MMM d, yyyy HH:mm')}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Diff View */}
            <div className="grid grid-cols-2 gap-4">
              <div className="border rounded-lg overflow-hidden">
                <div className="bg-muted px-4 py-2 border-b">
                  <p className="text-sm font-medium">Version {version.versionNumber}</p>
                </div>
                <ScrollArea className="h-[500px]">
                  <div className="p-4 font-mono text-sm">
                    {diff.map((line, index) => (
                      <div
                        key={index}
                        className={`leading-relaxed ${
                          line.type === 'removed'
                            ? 'bg-red-100 dark:bg-red-950/30 text-red-900 dark:text-red-300'
                            : line.type === 'modified'
                            ? 'bg-yellow-100 dark:bg-yellow-950/30 text-yellow-900 dark:text-yellow-300'
                            : ''
                        }`}
                      >
                        <span className="select-none text-muted-foreground mr-4">
                          {index + 1}
                        </span>
                        {line.oldLine || ' '}
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>

              <div className="border rounded-lg overflow-hidden">
                <div className="bg-muted px-4 py-2 border-b">
                  <p className="text-sm font-medium">Current Version</p>
                </div>
                <ScrollArea className="h-[500px]">
                  <div className="p-4 font-mono text-sm">
                    {diff.map((line, index) => (
                      <div
                        key={index}
                        className={`leading-relaxed ${
                          line.type === 'added'
                            ? 'bg-green-100 dark:bg-green-950/30 text-green-900 dark:text-green-300'
                            : line.type === 'modified'
                            ? 'bg-yellow-100 dark:bg-yellow-950/30 text-yellow-900 dark:text-yellow-300'
                            : ''
                        }`}
                      >
                        <span className="select-none text-muted-foreground mr-4">
                          {index + 1}
                        </span>
                        {line.newLine || ' '}
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            </div>

            {/* Legend */}
            <div className="flex items-center justify-center gap-6 text-sm">
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 bg-red-100 dark:bg-red-950/30 border border-red-300 dark:border-red-700 rounded" />
                <span>Removed</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 bg-green-100 dark:bg-green-950/30 border border-green-300 dark:border-green-700 rounded" />
                <span>Added</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 bg-yellow-100 dark:bg-yellow-950/30 border border-yellow-300 dark:border-yellow-700 rounded" />
                <span>Modified</span>
              </div>
            </div>

            {/* Actions */}
            <div className="flex justify-between pt-4 border-t">
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              <Button
                onClick={handleRestore}
                disabled={isRestoring}
                variant="destructive"
              >
                {isRestoring ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                    Restoring...
                  </>
                ) : (
                  <>
                    <RotateCcw className="h-4 w-4 mr-2" />
                    Restore to Version {version.versionNumber}
                  </>
                )}
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
