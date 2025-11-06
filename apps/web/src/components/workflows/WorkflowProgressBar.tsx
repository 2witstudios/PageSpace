'use client';

import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, Circle, AlertCircle, XCircle, Pause } from 'lucide-react';
import { cn } from '@/lib/utils';

interface WorkflowProgressBarProps {
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  progressPercentage: number;
  currentStepOrder: number | null;
  totalSteps: number;
}

export function WorkflowProgressBar({
  status,
  progressPercentage,
  currentStepOrder,
  totalSteps,
}: WorkflowProgressBarProps) {
  const getStatusColor = () => {
    switch (status) {
      case 'running':
        return 'bg-blue-500';
      case 'completed':
        return 'bg-green-500';
      case 'failed':
        return 'bg-red-500';
      case 'paused':
        return 'bg-yellow-500';
      case 'cancelled':
        return 'bg-gray-500';
      default:
        return 'bg-primary';
    }
  };

  const getStatusIcon = () => {
    switch (status) {
      case 'running':
        return <Circle className="size-4 animate-pulse text-blue-500" />;
      case 'completed':
        return <CheckCircle2 className="size-4 text-green-500" />;
      case 'failed':
        return <AlertCircle className="size-4 text-red-500" />;
      case 'paused':
        return <Pause className="size-4 text-yellow-500" />;
      case 'cancelled':
        return <XCircle className="size-4 text-gray-500" />;
    }
  };

  const getStatusBadgeVariant = () => {
    switch (status) {
      case 'completed':
        return 'default';
      case 'failed':
      case 'cancelled':
        return 'destructive';
      default:
        return 'secondary';
    }
  };

  const currentStep = currentStepOrder !== null ? currentStepOrder + 1 : 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {getStatusIcon()}
          <h3 className="text-lg font-semibold capitalize">{status}</h3>
          <Badge variant={getStatusBadgeVariant()}>
            Step {currentStep} of {totalSteps}
          </Badge>
        </div>
        <span className="text-2xl font-bold text-muted-foreground">
          {progressPercentage}%
        </span>
      </div>

      <Progress
        value={progressPercentage}
        className={cn(
          'h-3',
          status === 'running' && '[&>div]:animate-pulse'
        )}
      />

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {status === 'running' && 'Execution in progress...'}
          {status === 'paused' && 'Execution paused'}
          {status === 'completed' && 'Workflow completed successfully'}
          {status === 'failed' && 'Workflow execution failed'}
          {status === 'cancelled' && 'Workflow cancelled'}
        </span>
      </div>
    </div>
  );
}
