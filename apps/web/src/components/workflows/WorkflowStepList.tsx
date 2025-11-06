'use client';

import { WorkflowStepCard } from './WorkflowStepCard';

interface WorkflowStep {
  id: string;
  stepOrder: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  agentInput: Record<string, unknown> | null;
  agentOutput: Record<string, unknown> | null;
  userInput: Record<string, unknown> | null;
  startedAt: Date | null;
  completedAt: Date | null;
  errorMessage: string | null;
}

interface WorkflowStepListProps {
  steps: WorkflowStep[];
  currentStepOrder: number | null;
}

export function WorkflowStepList({
  steps,
  currentStepOrder,
}: WorkflowStepListProps) {
  if (steps.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <p>No steps found in this workflow.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {steps.map((step) => (
        <WorkflowStepCard
          key={step.id}
          step={step}
          agentName={`Agent ${step.stepOrder + 1}`}
          isCurrentStep={step.stepOrder === currentStepOrder}
          defaultExpanded={step.status === 'completed' && step.stepOrder === currentStepOrder}
        />
      ))}
    </div>
  );
}
