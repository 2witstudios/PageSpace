'use client';

import { useState, useEffect } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import {
  Card,
  CardContent,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
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
  FileText,
  ChevronDown,
  ChevronRight,
  Undo2,
  CheckCircle,
  XCircle,
  Clock,
  ExternalLink,
} from 'lucide-react';
import { toast } from 'sonner';
import { PageTypeIcon } from '@/components/common/PageTypeIcon';
import { fetchWithAuth, post } from '@/lib/auth-fetch';
import { getCsrfToken } from '@/lib/csrf';

interface AffectedPage {
  id: string;
  title: string;
  type: string;
  actionType: string;
}

interface AiOperation {
  id: string;
  operationType: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  prompt: string;
  affectedPages: AffectedPage[];
  createdAt: string;
  completedAt: string | null;
}

interface AiOperationControlsProps {
  messageId: string;
  className?: string;
}

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error('Failed to fetch AI operations');
  }
  return response.json();
};

const getStatusIcon = (status: AiOperation['status']) => {
  switch (status) {
    case 'COMPLETED':
      return <CheckCircle className="h-4 w-4 text-green-600" />;
    case 'FAILED':
      return <XCircle className="h-4 w-4 text-destructive" />;
    case 'IN_PROGRESS':
    case 'PENDING':
      return <Clock className="h-4 w-4 text-yellow-600 animate-pulse" />;
    case 'CANCELLED':
      return <XCircle className="h-4 w-4 text-muted-foreground" />;
  }
};

const getStatusColor = (status: AiOperation['status']) => {
  switch (status) {
    case 'COMPLETED':
      return 'default';
    case 'FAILED':
      return 'destructive';
    case 'IN_PROGRESS':
    case 'PENDING':
      return 'secondary';
    case 'CANCELLED':
      return 'outline';
  }
};

export function AiOperationControls({ messageId, className }: AiOperationControlsProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [undoDialogOpen, setUndoDialogOpen] = useState(false);
  const [selectedOperation, setSelectedOperation] = useState<AiOperation | null>(null);
  const [isUndoing, setIsUndoing] = useState(false);

  const { data, error, mutate } = useSWR<{ operations: AiOperation[] }>(
    messageId ? `/api/ai/operations/by-message/${messageId}` : null,
    fetcher,
    {
      revalidateOnFocus: false,
    }
  );

  // Auto-expand if there are operations
  useEffect(() => {
    if (data?.operations && data.operations.length > 0) {
      setIsExpanded(true);
    }
  }, [data?.operations]);

  const handleUndoClick = (operation: AiOperation) => {
    setSelectedOperation(operation);
    setUndoDialogOpen(true);
  };

  const handleUndoConfirm = async () => {
    if (!selectedOperation) return;

    setIsUndoing(true);
    try {
      const csrfToken = await getCsrfToken();
      const response = await post(
        `/api/ai/operations/${selectedOperation.id}/undo`,
        {},
        {
          headers: {
            'X-CSRF-Token': csrfToken,
          },
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to undo operation');
      }

      const result = await response.json();
      toast.success(`Successfully undid ${result.revertedCount} change(s)`);
      setUndoDialogOpen(false);
      setSelectedOperation(null);
      mutate(); // Refresh the operations list
    } catch (error) {
      console.error('Error undoing operation:', error);
      toast.error(
        error instanceof Error ? error.message : 'Failed to undo changes'
      );
    } finally {
      setIsUndoing(false);
    }
  };

  if (error || !data?.operations || data.operations.length === 0) {
    return null;
  }

  const operations = data.operations;
  const totalAffectedPages = operations.reduce(
    (sum, op) => sum + op.affectedPages.length,
    0
  );

  return (
    <>
      <Card className={className}>
        <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
          <CollapsibleTrigger asChild>
            <div className="flex items-center justify-between p-3 cursor-pointer hover:bg-muted/50 transition-colors border-b">
              <div className="flex items-center gap-2">
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
                <FileText className="h-4 w-4 text-primary" />
                <span className="text-sm font-medium">
                  Modified {totalAffectedPages} page{totalAffectedPages !== 1 ? 's' : ''}
                </span>
                {operations.some(op => op.status === 'COMPLETED') && (
                  <Badge variant="secondary" className="text-xs">
                    Can undo
                  </Badge>
                )}
              </div>
            </div>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <CardContent className="p-3 space-y-3">
              {operations.map((operation) => (
                <div
                  key={operation.id}
                  className="border rounded-lg p-3 space-y-2"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant={getStatusColor(operation.status)}>
                          {getStatusIcon(operation.status)}
                          <span className="ml-1">{operation.status}</span>
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {operation.operationType.replace(/_/g, ' ')}
                        </span>
                      </div>

                      {operation.prompt && (
                        <p className="text-sm text-muted-foreground italic line-clamp-2">
                          "{operation.prompt}"
                        </p>
                      )}
                    </div>

                    {operation.status === 'COMPLETED' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleUndoClick(operation)}
                      >
                        <Undo2 className="h-3.5 w-3.5 mr-1" />
                        Undo
                      </Button>
                    )}
                  </div>

                  {operation.affectedPages.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">
                        Affected pages:
                      </p>
                      {operation.affectedPages.map((page) => (
                        <Link
                          key={page.id}
                          href={`/pages/${page.id}`}
                          className="flex items-center gap-2 p-2 rounded hover:bg-muted transition-colors group"
                        >
                          <PageTypeIcon type={page.type} className="h-3.5 w-3.5" />
                          <span className="text-sm flex-1 group-hover:text-primary">
                            {page.title}
                          </span>
                          <Badge variant="outline" className="text-xs">
                            {page.actionType.replace(/_/g, ' ')}
                          </Badge>
                          <ExternalLink className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>

      {/* Undo Confirmation Dialog */}
      <AlertDialog open={undoDialogOpen} onOpenChange={setUndoDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Undo2 className="h-5 w-5 text-destructive" />
              Undo AI Changes?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will revert all changes made by this AI operation. The affected
              pages will be restored to their previous state.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {selectedOperation && (
            <div className="bg-muted p-4 rounded-lg space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Operation:</span>
                <span className="font-medium">
                  {selectedOperation.operationType.replace(/_/g, ' ')}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Affected pages:</span>
                <span className="font-medium">
                  {selectedOperation.affectedPages.length}
                </span>
              </div>
              {selectedOperation.prompt && (
                <div className="pt-2 border-t">
                  <p className="text-xs text-muted-foreground mb-1">Original prompt:</p>
                  <p className="text-sm italic">"{selectedOperation.prompt}"</p>
                </div>
              )}
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isUndoing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleUndoConfirm}
              disabled={isUndoing}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isUndoing ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                  Undoing...
                </>
              ) : (
                <>
                  <Undo2 className="h-4 w-4 mr-2" />
                  Undo Changes
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
