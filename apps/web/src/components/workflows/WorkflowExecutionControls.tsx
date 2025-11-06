'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Pause, Play, XCircle, Loader2 } from 'lucide-react';

interface WorkflowExecutionControlsProps {
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  onCancel: () => Promise<void>;
}

export function WorkflowExecutionControls({
  status,
  onPause,
  onResume,
  onCancel,
}: WorkflowExecutionControlsProps) {
  const [isPausing, setIsPausing] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);

  const handlePause = async () => {
    setIsPausing(true);
    try {
      await onPause();
    } finally {
      setIsPausing(false);
    }
  };

  const handleResume = async () => {
    setIsResuming(true);
    try {
      await onResume();
    } finally {
      setIsResuming(false);
    }
  };

  const handleCancel = async () => {
    setIsCancelling(true);
    try {
      await onCancel();
      setShowCancelDialog(false);
    } finally {
      setIsCancelling(false);
    }
  };

  const canControl = status === 'running' || status === 'paused';

  if (!canControl) {
    return null;
  }

  return (
    <>
      <div className="flex items-center justify-end gap-2 p-4 border-t bg-muted/30 sticky bottom-0">
        {status === 'running' && (
          <Button
            variant="outline"
            onClick={handlePause}
            disabled={isPausing}
          >
            {isPausing ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Pausing...
              </>
            ) : (
              <>
                <Pause className="size-4" />
                Pause
              </>
            )}
          </Button>
        )}

        {status === 'paused' && (
          <Button
            onClick={handleResume}
            disabled={isResuming}
          >
            {isResuming ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Resuming...
              </>
            ) : (
              <>
                <Play className="size-4" />
                Resume
              </>
            )}
          </Button>
        )}

        <Button
          variant="destructive"
          onClick={() => setShowCancelDialog(true)}
          disabled={isCancelling}
        >
          <XCircle className="size-4" />
          Cancel
        </Button>
      </div>

      <Dialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel Workflow Execution</DialogTitle>
            <DialogDescription>
              Are you sure you want to cancel this workflow execution? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowCancelDialog(false)}
              disabled={isCancelling}
            >
              Keep Running
            </Button>
            <Button
              variant="destructive"
              onClick={handleCancel}
              disabled={isCancelling}
            >
              {isCancelling ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Cancelling...
                </>
              ) : (
                'Cancel Workflow'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
