'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import {
  WorkflowStepCardBuilder,
  StepConfig,
} from './WorkflowStepCardBuilder';

interface WorkflowStepBuilderProps {
  steps: StepConfig[];
  onStepsChange: (steps: StepConfig[]) => void;
  agents: Array<{ id: string; title: string }>;
}

export function WorkflowStepBuilder({
  steps,
  onStepsChange,
  agents,
}: WorkflowStepBuilderProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  );

  const addStep = () => {
    const newStep: StepConfig = {
      id: `step_${Date.now()}`,
      stepOrder: steps.length,
      agentId: '',
      promptTemplate: '',
      requiresUserInput: false,
      inputSchema: null,
      metadata: null,
    };
    onStepsChange([...steps, newStep]);
  };

  const updateStep = (id: string, updates: Partial<StepConfig>) => {
    onStepsChange(
      steps.map((step) => (step.id === id ? { ...step, ...updates } : step))
    );
  };

  const removeStep = (id: string) => {
    const updatedSteps = steps
      .filter((step) => step.id !== id)
      .map((step, index) => ({ ...step, stepOrder: index }));
    onStepsChange(updatedSteps);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = steps.findIndex((s) => s.id === active.id);
      const newIndex = steps.findIndex((s) => s.id === over.id);

      const reorderedSteps = arrayMove(steps, oldIndex, newIndex).map(
        (step, index) => ({
          ...step,
          stepOrder: index,
        })
      );

      onStepsChange(reorderedSteps);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Workflow Steps</h3>
          <p className="text-sm text-muted-foreground">
            Define the sequence of AI agent tasks for this workflow
          </p>
        </div>
        <Button type="button" onClick={addStep} variant="outline">
          <Plus className="size-4 mr-2" />
          Add Step
        </Button>
      </div>

      {steps.length === 0 ? (
        <div className="border-2 border-dashed rounded-lg p-8 text-center">
          <p className="text-muted-foreground mb-4">
            No steps defined yet. Click "Add Step" to create your first workflow
            step.
          </p>
          <Button type="button" onClick={addStep}>
            <Plus className="size-4 mr-2" />
            Add First Step
          </Button>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={steps.map((s) => s.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-3">
              {steps.map((step, index) => (
                <WorkflowStepCardBuilder
                  key={step.id}
                  step={step}
                  index={index}
                  agents={agents}
                  onUpdate={updateStep}
                  onRemove={removeStep}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}
