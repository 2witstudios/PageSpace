'use client';

import { useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  CheckCircle2,
  Circle,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  SkipForward,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDistanceToNow } from 'date-fns';

interface WorkflowStepCardProps {
  step: {
    id: string;
    stepOrder: number;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
    agentInput: Record<string, unknown> | null;
    agentOutput: Record<string, unknown> | null;
    userInput: Record<string, unknown> | null;
    startedAt: Date | null;
    completedAt: Date | null;
    errorMessage: string | null;
  };
  agentName?: string;
  isCurrentStep: boolean;
  defaultExpanded?: boolean;
}

export function WorkflowStepCard({
  step,
  agentName = 'Agent',
  isCurrentStep,
  defaultExpanded = false,
}: WorkflowStepCardProps) {
  const [isExpanded, setIsExpanded] = useState(
    defaultExpanded || isCurrentStep || step.status === 'running'
  );

  const getStatusIcon = () => {
    switch (step.status) {
      case 'pending':
        return <Circle className="size-4 text-gray-400" />;
      case 'running':
        return <Loader2 className="size-4 text-blue-500 animate-spin" />;
      case 'completed':
        return <CheckCircle2 className="size-4 text-green-500" />;
      case 'failed':
        return <AlertCircle className="size-4 text-red-500" />;
      case 'skipped':
        return <SkipForward className="size-4 text-gray-400" />;
    }
  };

  const getStatusBadge = () => {
    const variants: Record<typeof step.status, 'default' | 'secondary' | 'destructive' | 'outline'> = {
      pending: 'outline',
      running: 'default',
      completed: 'secondary',
      failed: 'destructive',
      skipped: 'outline',
    };

    return (
      <Badge variant={variants[step.status]} className="capitalize">
        {step.status}
      </Badge>
    );
  };

  const formatTimestamp = (date: Date | null) => {
    if (!date) return null;
    return formatDistanceToNow(new Date(date), { addSuffix: true });
  };

  const formatJson = (data: Record<string, unknown> | null) => {
    if (!data) return null;
    return JSON.stringify(data, null, 2);
  };

  return (
    <Card
      className={cn(
        'transition-all',
        isCurrentStep && 'border-primary ring-2 ring-primary/20',
        step.status === 'failed' && 'border-red-300 bg-red-50/50 dark:bg-red-950/20'
      )}
    >
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            {getStatusIcon()}
            <div className="flex-1 min-w-0">
              <CardTitle className="text-base">
                Step {step.stepOrder + 1}: {agentName}
              </CardTitle>
              {step.startedAt && (
                <CardDescription className="flex items-center gap-1 mt-1">
                  <Clock className="size-3" />
                  Started {formatTimestamp(step.startedAt)}
                  {step.completedAt && ` • Completed ${formatTimestamp(step.completedAt)}`}
                </CardDescription>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {getStatusBadge()}
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={() => setIsExpanded(!isExpanded)}
            >
              {isExpanded ? (
                <ChevronDown className="size-4" />
              ) : (
                <ChevronRight className="size-4" />
              )}
            </Button>
          </div>
        </div>
      </CardHeader>

      {isExpanded && (
        <CardContent className="space-y-4 pt-0">
          {step.errorMessage && (
            <div className="p-3 bg-red-100 dark:bg-red-950/50 rounded-md border border-red-300 dark:border-red-800">
              <p className="text-sm font-medium text-red-800 dark:text-red-200">
                Error
              </p>
              <p className="text-sm text-red-700 dark:text-red-300 mt-1">
                {step.errorMessage}
              </p>
            </div>
          )}

          {step.userInput && (
            <div className="space-y-2">
              <p className="text-sm font-medium">User Input</p>
              <pre className="text-xs bg-muted p-3 rounded-md overflow-x-auto">
                {formatJson(step.userInput)}
              </pre>
            </div>
          )}

          {step.agentInput && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Agent Input</p>
              <pre className="text-xs bg-muted p-3 rounded-md overflow-x-auto">
                {formatJson(step.agentInput)}
              </pre>
            </div>
          )}

          {step.agentOutput && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Agent Output</p>
              <pre className="text-xs bg-muted p-3 rounded-md overflow-x-auto">
                {formatJson(step.agentOutput)}
              </pre>
            </div>
          )}

          {step.status === 'pending' && (
            <p className="text-sm text-muted-foreground italic">
              This step has not started yet.
            </p>
          )}

          {step.status === 'running' && !step.agentOutput && (
            <p className="text-sm text-muted-foreground italic flex items-center gap-2">
              <Loader2 className="size-3 animate-spin" />
              Executing step...
            </p>
          )}
        </CardContent>
      )}
    </Card>
  );
}
