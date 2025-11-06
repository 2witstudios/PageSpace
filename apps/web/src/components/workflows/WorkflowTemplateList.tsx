'use client';

import { WorkflowTemplateCard } from './WorkflowTemplateCard';
import { Skeleton } from '@/components/ui/skeleton';
import { Card } from '@/components/ui/card';
import { Workflow } from 'lucide-react';

interface WorkflowTemplate {
  id: string;
  name: string;
  description: string | null;
  driveId: string;
  category: string | null;
  tags: string[] | null;
  isPublic: boolean;
  stepCount: number;
  createdAt: Date;
}

interface WorkflowTemplateListProps {
  templates: WorkflowTemplate[];
  isLoading: boolean;
  onStartWorkflow?: (templateId: string) => void;
}

function LoadingSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i}>
          <div className="p-6 space-y-4">
            <div className="space-y-2">
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </div>
            <div className="flex gap-2">
              <Skeleton className="h-6 w-20" />
              <Skeleton className="h-6 w-16" />
            </div>
            <Skeleton className="h-9 w-full" />
          </div>
        </Card>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-4">
      <div className="rounded-full bg-muted p-4 mb-4">
        <Workflow className="size-8 text-muted-foreground" />
      </div>
      <h3 className="text-lg font-semibold mb-2">No workflows found</h3>
      <p className="text-sm text-muted-foreground text-center max-w-sm">
        No workflow templates match your current filters. Try adjusting your
        search criteria or create a new workflow template.
      </p>
    </div>
  );
}

export function WorkflowTemplateList({
  templates,
  isLoading,
  onStartWorkflow,
}: WorkflowTemplateListProps) {
  if (isLoading) {
    return <LoadingSkeleton />;
  }

  if (templates.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {templates.map((template) => (
        <WorkflowTemplateCard
          key={template.id}
          template={template}
          onStart={onStartWorkflow}
        />
      ))}
    </div>
  );
}
