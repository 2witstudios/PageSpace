'use client';

import { useCallback } from 'react';
import { useToast } from '@/hooks/use-toast';

interface UseExecutionControlsResult {
  pauseExecution: () => Promise<void>;
  resumeExecution: () => Promise<void>;
  cancelExecution: () => Promise<void>;
  submitUserInput: (userInput: Record<string, unknown>) => Promise<void>;
  executeNextStep: () => Promise<void>;
}

export function useExecutionControls(
  executionId: string | null,
  onUpdate?: () => void
): UseExecutionControlsResult {
  const { toast } = useToast();

  const pauseExecution = useCallback(async () => {
    if (!executionId) {
      throw new Error('No execution ID provided');
    }

    const response = await fetch(`/api/workflows/executions/${executionId}/pause`, {
      method: 'POST',
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to pause execution');
    }

    toast({
      title: 'Execution paused',
      description: 'The workflow execution has been paused.',
    });

    onUpdate?.();
  }, [executionId, toast, onUpdate]);

  const resumeExecution = useCallback(async () => {
    if (!executionId) {
      throw new Error('No execution ID provided');
    }

    const response = await fetch(`/api/workflows/executions/${executionId}/resume`, {
      method: 'POST',
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to resume execution');
    }

    toast({
      title: 'Execution resumed',
      description: 'The workflow execution has been resumed.',
    });

    onUpdate?.();
  }, [executionId, toast, onUpdate]);

  const cancelExecution = useCallback(async () => {
    if (!executionId) {
      throw new Error('No execution ID provided');
    }

    const response = await fetch(`/api/workflows/executions/${executionId}/cancel`, {
      method: 'POST',
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to cancel execution');
    }

    toast({
      title: 'Execution cancelled',
      description: 'The workflow execution has been cancelled.',
      variant: 'destructive',
    });

    onUpdate?.();
  }, [executionId, toast, onUpdate]);

  const submitUserInput = useCallback(
    async (userInput: Record<string, unknown>) => {
      if (!executionId) {
        throw new Error('No execution ID provided');
      }

      const response = await fetch(`/api/workflows/executions/${executionId}/input`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ userInput }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to submit user input');
      }

      onUpdate?.();
    },
    [executionId, onUpdate]
  );

  const executeNextStep = useCallback(async () => {
    if (!executionId) {
      throw new Error('No execution ID provided');
    }

    const response = await fetch(`/api/workflows/executions/${executionId}/next`, {
      method: 'POST',
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to execute next step');
    }

    onUpdate?.();
  }, [executionId, onUpdate]);

  return {
    pauseExecution,
    resumeExecution,
    cancelExecution,
    submitUserInput,
    executeNextStep,
  };
}
