'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertCircle, CheckCircle2, XCircle } from 'lucide-react';
import { useWorkflowExecution } from '@/hooks/workflows/useWorkflowExecution';
import { useExecutionControls } from '@/hooks/workflows/useExecutionControls';
import { useAutoExecuteSteps } from '@/hooks/workflows/useAutoExecuteSteps';
import { WorkflowProgressBar } from './WorkflowProgressBar';
import { WorkflowStepList } from './WorkflowStepList';
import { WorkflowUserInputForm } from './WorkflowUserInputForm';
import { WorkflowExecutionControls } from './WorkflowExecutionControls';
import { WorkflowAccumulatedContext } from './WorkflowAccumulatedContext';

interface WorkflowExecutionViewProps {
  executionId: string;
}

export function WorkflowExecutionView({ executionId }: WorkflowExecutionViewProps) {
  const router = useRouter();
  const { execution, isLoading, isError, error, refresh } = useWorkflowExecution(executionId);
  const {
    pauseExecution,
    resumeExecution,
    cancelExecution,
    submitUserInput,
  } = useExecutionControls(executionId, refresh);

  useAutoExecuteSteps({
    executionId,
    execution,
    onUpdate: refresh,
  });

  useEffect(() => {
    if (execution?.execution.status === 'completed') {
      const timer = setTimeout(() => {
        refresh();
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [execution?.execution.status, refresh]);

  if (isLoading) {
    return <WorkflowExecutionSkeleton />;
  }

  if (isError || !execution) {
    return (
      <div className="container mx-auto py-8 px-4 max-w-4xl">
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>
            {error?.message || 'Failed to load workflow execution'}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const currentStep = execution.steps.find(
    (s) => s.stepOrder === execution.execution.currentStepOrder
  );

  const requiresUserInput =
    currentStep?.status === 'running' &&
    execution.execution.status === 'running';

  return (
    <div className="container mx-auto py-8 px-4 max-w-5xl">
      <div className="space-y-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-bold">{execution.template?.name}</h1>
            {execution.template?.description && (
              <p className="text-muted-foreground mt-2">
                {execution.template.description}
              </p>
            )}
          </div>
        </div>

        <WorkflowProgressBar
          status={execution.execution.status}
          progressPercentage={execution.progressPercentage}
          currentStepOrder={execution.execution.currentStepOrder}
          totalSteps={execution.steps.length}
        />

        {execution.execution.status === 'completed' && (
          <Alert className="border-green-300 bg-green-50 dark:bg-green-950/20">
            <CheckCircle2 className="size-4 text-green-600" />
            <AlertDescription className="text-green-800 dark:text-green-200">
              Workflow completed successfully! All steps have been executed.
            </AlertDescription>
          </Alert>
        )}

        {execution.execution.status === 'failed' && execution.execution.errorMessage && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertDescription>
              Workflow failed: {execution.execution.errorMessage}
            </AlertDescription>
          </Alert>
        )}

        {execution.execution.status === 'cancelled' && (
          <Alert className="border-gray-300 bg-gray-50 dark:bg-gray-950/20">
            <XCircle className="size-4 text-gray-600" />
            <AlertDescription className="text-gray-800 dark:text-gray-200">
              Workflow execution was cancelled.
            </AlertDescription>
          </Alert>
        )}

        {requiresUserInput && currentStep && (
          <WorkflowUserInputForm
            executionId={executionId}
            stepOrder={currentStep.stepOrder}
            inputSchema={currentStep.agentInput?.inputSchema as Record<string, unknown> | undefined}
            onSubmit={submitUserInput}
          />
        )}

        <div className="space-y-4">
          <h2 className="text-xl font-semibold">Execution Steps</h2>
          <WorkflowStepList
            steps={execution.steps}
            currentStepOrder={execution.execution.currentStepOrder}
          />
        </div>

        {Object.keys(execution.execution.accumulatedContext).length > 0 && (
          <WorkflowAccumulatedContext
            context={execution.execution.accumulatedContext}
          />
        )}

        <WorkflowExecutionControls
          status={execution.execution.status}
          onPause={pauseExecution}
          onResume={resumeExecution}
          onCancel={cancelExecution}
        />
      </div>
    </div>
  );
}

function WorkflowExecutionSkeleton() {
  return (
    <div className="container mx-auto py-8 px-4 max-w-5xl">
      <div className="space-y-6">
        <div>
          <Skeleton className="h-9 w-64 mb-2" />
          <Skeleton className="h-5 w-96" />
        </div>

        <Card>
          <CardContent className="pt-6">
            <Skeleton className="h-3 w-full mb-4" />
            <div className="flex justify-between">
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-6 w-16" />
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardContent className="pt-6">
                <Skeleton className="h-6 w-48 mb-2" />
                <Skeleton className="h-4 w-32" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
