'use client';

import { useEffect, useRef } from 'react';
import { useExecutionControls } from './useExecutionControls';

interface ExecutionState {
  execution: {
    status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
    currentStepOrder: number | null;
  };
  steps: Array<{
    stepOrder: number;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  }>;
}

interface UseAutoExecuteStepsOptions {
  executionId: string | null;
  execution: ExecutionState | null;
  onUpdate?: () => void;
}

export function useAutoExecuteSteps({
  executionId,
  execution,
  onUpdate,
}: UseAutoExecuteStepsOptions) {
  const { executeNextStep } = useExecutionControls(executionId, onUpdate);
  const isExecutingRef = useRef(false);

  useEffect(() => {
    if (!execution || !executionId) {
      return;
    }

    const shouldAutoExecute = () => {
      if (execution.execution.status !== 'running') {
        return false;
      }

      const currentStepOrder = execution.execution.currentStepOrder;

      if (currentStepOrder === null) {
        return true;
      }

      const currentStep = execution.steps.find(
        (s) => s.stepOrder === currentStepOrder
      );

      if (!currentStep) {
        return false;
      }

      if (currentStep.status === 'completed') {
        const nextStepOrder = currentStepOrder + 1;
        const nextStep = execution.steps.find((s) => s.stepOrder === nextStepOrder);

        if (nextStep && nextStep.status === 'pending') {
          return true;
        }
      }

      return false;
    };

    const autoExecute = async () => {
      if (isExecutingRef.current) {
        return;
      }

      if (shouldAutoExecute()) {
        isExecutingRef.current = true;
        try {
          await executeNextStep();
        } catch (error) {
          console.error('Failed to auto-execute next step:', error);
        } finally {
          isExecutingRef.current = false;
        }
      }
    };

    autoExecute();
  }, [execution, executionId, executeNextStep]);
}
