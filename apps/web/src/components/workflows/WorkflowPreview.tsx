'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { StepConfig } from './WorkflowStepCardBuilder';

interface WorkflowPreviewProps {
  name: string;
  description: string;
  category: string;
  tags: string[];
  isPublic: boolean;
  steps: StepConfig[];
  agents: Array<{ id: string; title: string }>;
}

export function WorkflowPreview({
  name,
  description,
  category,
  tags,
  isPublic,
  steps,
  agents,
}: WorkflowPreviewProps) {
  const getAgentName = (agentId: string) => {
    const agent = agents.find((a) => a.id === agentId);
    return agent?.title || 'Unknown Agent';
  };

  return (
    <Card className="sticky top-4">
      <CardHeader>
        <CardTitle>Preview</CardTitle>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[calc(100vh-200px)]">
          <div className="space-y-4 pr-4">
            {/* Workflow metadata */}
            <div>
              <h4 className="font-semibold text-lg mb-1">{name || 'Untitled Workflow'}</h4>
              {description && (
                <p className="text-sm text-muted-foreground mb-2">{description}</p>
              )}

              <div className="flex flex-wrap gap-2 mt-2">
                {category && <Badge variant="secondary">{category}</Badge>}
                {isPublic && <Badge variant="outline">Public</Badge>}
                {tags.map((tag) => (
                  <Badge key={tag} variant="outline">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>

            {/* Step count */}
            <div className="border-t pt-4">
              <p className="text-sm font-medium mb-3">
                {steps.length} {steps.length === 1 ? 'Step' : 'Steps'}
              </p>

              {steps.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No steps defined yet
                </p>
              ) : (
                <div className="space-y-3">
                  {steps.map((step, index) => (
                    <div key={step.id} className="space-y-1">
                      <div className="flex items-center gap-2">
                        <div className="flex items-center justify-center size-6 rounded-full bg-primary text-primary-foreground font-semibold text-xs shrink-0">
                          {index + 1}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">
                            {step.agentId ? getAgentName(step.agentId) : 'No agent selected'}
                          </p>
                          {step.requiresUserInput && (
                            <Badge variant="outline" className="text-xs mt-1">
                              Requires Input
                            </Badge>
                          )}
                        </div>
                      </div>

                      {step.promptTemplate && (
                        <div className="ml-8 bg-muted/50 rounded p-2">
                          <p className="text-xs font-mono line-clamp-3">
                            {step.promptTemplate}
                          </p>
                        </div>
                      )}

                      {index < steps.length - 1 && (
                        <div className="ml-3 w-0.5 h-4 bg-border" />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Summary */}
            <div className="border-t pt-4">
              <h5 className="font-semibold text-sm mb-2">Summary</h5>
              <div className="space-y-1 text-xs text-muted-foreground">
                <p>Total steps: {steps.length}</p>
                <p>
                  Steps requiring input:{' '}
                  {steps.filter((s) => s.requiresUserInput).length}
                </p>
                <p>
                  Unique agents:{' '}
                  {new Set(steps.map((s) => s.agentId).filter(Boolean)).size}
                </p>
              </div>
            </div>
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
