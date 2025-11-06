'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Workflow, Lock, Users, ChevronRight } from 'lucide-react';

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

interface WorkflowTemplateCardProps {
  template: WorkflowTemplate;
  onStart?: (templateId: string) => void;
}

export function WorkflowTemplateCard({
  template,
  onStart,
}: WorkflowTemplateCardProps) {
  const router = useRouter();
  const [isStarting, setIsStarting] = useState(false);

  const handleStartWorkflow = async () => {
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

      if (onStart) {
        onStart(template.id);
      }

      // Navigate to execution view
      router.push(`/workflows/executions/${execution.execution.id}`);
    } catch (error) {
      console.error('Failed to start workflow:', error);
    } finally {
      setIsStarting(false);
    }
  };

  const handleViewDetails = () => {
    router.push(`/workflows/templates/${template.id}`);
  };

  return (
    <Card className="hover:shadow-md transition-shadow">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Workflow className="size-4 text-primary shrink-0" />
              <CardTitle className="truncate">{template.name}</CardTitle>
            </div>
            <CardDescription className="line-clamp-2">
              {template.description || 'No description provided'}
            </CardDescription>
          </div>
          {template.isPublic ? (
            <Users className="size-4 text-muted-foreground shrink-0" />
          ) : (
            <Lock className="size-4 text-muted-foreground shrink-0" />
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {template.category && (
          <Badge variant="secondary">{template.category}</Badge>
        )}

        {template.tags && template.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {template.tags.map((tag) => (
              <Badge key={tag} variant="outline" className="text-xs">
                {tag}
              </Badge>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="font-medium">{template.stepCount}</span>
          <span>{template.stepCount === 1 ? 'step' : 'steps'}</span>
        </div>
      </CardContent>

      <CardFooter className="flex gap-2">
        <Button
          onClick={handleStartWorkflow}
          disabled={isStarting}
          className="flex-1"
        >
          {isStarting ? 'Starting...' : 'Start Workflow'}
        </Button>
        <Button
          variant="outline"
          onClick={handleViewDetails}
          size="icon"
        >
          <ChevronRight className="size-4" />
        </Button>
      </CardFooter>
    </Card>
  );
}
