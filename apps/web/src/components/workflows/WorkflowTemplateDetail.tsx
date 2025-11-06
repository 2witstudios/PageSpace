'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Workflow,
  Lock,
  Users,
  ArrowLeft,
  PlayCircle,
  AlertCircle,
  Pencil,
} from 'lucide-react';

interface WorkflowStep {
  id: string;
  stepOrder: number;
  agentId: string;
  promptTemplate: string;
  requiresUserInput: boolean;
  inputSchema: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

interface WorkflowTemplate {
  id: string;
  name: string;
  description: string | null;
  driveId: string;
  category: string | null;
  tags: string[] | null;
  isPublic: boolean;
  createdAt: Date;
  updatedAt: Date;
  steps: WorkflowStep[];
}

interface WorkflowTemplateDetailProps {
  template: WorkflowTemplate | null;
  isLoading: boolean;
  isError: boolean;
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-20 w-full" />
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    </div>
  );
}

export function WorkflowTemplateDetail({
  template,
  isLoading,
  isError,
}: WorkflowTemplateDetailProps) {
  const router = useRouter();
  const [isStarting, setIsStarting] = useState(false);

  const handleStartWorkflow = async () => {
    if (!template) return;

    setIsStarting(true);
    try {
      const response = await fetch('/api/workflows/executions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateId: template.id,
          initialContext: {},
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to start workflow');
      }

      const execution = await response.json();
      router.push(`/workflows/executions/${execution.execution.id}`);
    } catch (error) {
      console.error('Failed to start workflow:', error);
    } finally {
      setIsStarting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="container mx-auto py-8 px-4 max-w-4xl">
        <LoadingSkeleton />
      </div>
    );
  }

  if (isError || !template) {
    return (
      <div className="container mx-auto py-8 px-4 max-w-4xl">
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>
            Failed to load workflow template. The template may not exist or you
            may not have permission to view it.
          </AlertDescription>
        </Alert>
        <div className="flex justify-center mt-4">
          <Button onClick={() => router.back()} variant="outline">
            Go Back
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8 px-4 max-w-4xl">
      {/* Header */}
      <div className="mb-6">
        <Button
          variant="ghost"
          onClick={() => router.back()}
          className="mb-4"
        >
          <ArrowLeft className="size-4 mr-2" />
          Back to Workflows
        </Button>

        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <Workflow className="size-6 text-primary" />
              <h1 className="text-3xl font-bold">{template.name}</h1>
              {template.isPublic ? (
                <Users className="size-5 text-muted-foreground" />
              ) : (
                <Lock className="size-5 text-muted-foreground" />
              )}
            </div>
            <p className="text-muted-foreground">
              {template.description || 'No description provided'}
            </p>
          </div>

          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => router.push(`/workflows/templates/${template.id}/edit`)}
              size="lg"
              className="shrink-0"
            >
              <Pencil className="size-4 mr-2" />
              Edit
            </Button>
            <Button
              onClick={handleStartWorkflow}
              disabled={isStarting}
              size="lg"
              className="shrink-0"
            >
              <PlayCircle className="size-4 mr-2" />
              {isStarting ? 'Starting...' : 'Start Workflow'}
            </Button>
          </div>
        </div>
      </div>

      {/* Metadata */}
      <Card className="mb-6">
        <CardContent className="pt-6">
          <div className="flex flex-wrap gap-4 items-center">
            {template.category && (
              <div>
                <span className="text-sm text-muted-foreground mr-2">
                  Category:
                </span>
                <Badge variant="secondary">{template.category}</Badge>
              </div>
            )}

            <div>
              <span className="text-sm text-muted-foreground mr-2">Steps:</span>
              <Badge variant="outline">{template.steps.length}</Badge>
            </div>

            {template.tags && template.tags.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Tags:</span>
                <div className="flex flex-wrap gap-1">
                  {template.tags.map((tag) => (
                    <Badge key={tag} variant="outline">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Steps */}
      <Card>
        <CardHeader>
          <CardTitle>Workflow Steps</CardTitle>
          <CardDescription>
            This workflow will execute the following steps in sequence
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {template.steps
            .sort((a, b) => a.stepOrder - b.stepOrder)
            .map((step, index) => (
              <div key={step.id}>
                <div className="flex gap-4">
                  <div className="flex flex-col items-center">
                    <div className="flex items-center justify-center size-8 rounded-full bg-primary text-primary-foreground font-semibold text-sm shrink-0">
                      {step.stepOrder + 1}
                    </div>
                    {index < template.steps.length - 1 && (
                      <div className="w-0.5 h-full bg-border my-2 min-h-[40px]" />
                    )}
                  </div>

                  <div className="flex-1 pb-4">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold">Step {step.stepOrder + 1}</h3>
                        {step.requiresUserInput && (
                          <Badge variant="outline" className="text-xs">
                            Requires Input
                          </Badge>
                        )}
                      </div>

                      <p className="text-sm text-muted-foreground">
                        Agent ID: <code className="text-xs bg-muted px-1 py-0.5 rounded">{step.agentId}</code>
                      </p>

                      <div className="bg-muted/50 rounded-md p-3">
                        <p className="text-sm font-mono whitespace-pre-wrap">
                          {step.promptTemplate}
                        </p>
                      </div>

                      {step.metadata && Object.keys(step.metadata).length > 0 && (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                            Additional metadata
                          </summary>
                          <pre className="mt-2 bg-muted p-2 rounded overflow-auto">
                            {JSON.stringify(step.metadata, null, 2)}
                          </pre>
                        </details>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
        </CardContent>
      </Card>

      {/* Footer Actions */}
      <div className="flex justify-end gap-2 mt-6">
        <Button variant="outline" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button onClick={handleStartWorkflow} disabled={isStarting}>
          <PlayCircle className="size-4 mr-2" />
          {isStarting ? 'Starting Workflow...' : 'Start Workflow'}
        </Button>
      </div>
    </div>
  );
}
