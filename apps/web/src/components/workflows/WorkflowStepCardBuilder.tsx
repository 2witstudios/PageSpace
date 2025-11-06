'use client';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import {
  GripVertical,
  Trash2,
  Info,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { WorkflowInputSchemaBuilder } from './WorkflowInputSchemaBuilder';
import { useState } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

export interface StepConfig {
  id: string;
  stepOrder: number;
  agentId: string;
  promptTemplate: string;
  requiresUserInput: boolean;
  inputSchema: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

interface WorkflowStepCardBuilderProps {
  step: StepConfig;
  index: number;
  agents: Array<{ id: string; title: string }>;
  onUpdate: (id: string, updates: Partial<StepConfig>) => void;
  onRemove: (id: string) => void;
}

export function WorkflowStepCardBuilder({
  step,
  index,
  agents,
  onUpdate,
  onRemove,
}: WorkflowStepCardBuilderProps) {
  const [showHelp, setShowHelp] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: step.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const selectedAgent = agents.find((a) => a.id === step.agentId);

  return (
    <Card ref={setNodeRef} style={style} className="relative">
      <CardContent className="pt-4 space-y-4">
        {/* Header with drag handle and step number */}
        <div className="flex items-start gap-3">
          <div
            className="cursor-grab active:cursor-grabbing mt-2"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="size-5 text-muted-foreground" />
          </div>

          <div className="flex-1 space-y-3">
            {/* Step number and expand/collapse */}
            <div className="flex items-center justify-between">
              <Collapsible open={isExpanded} onOpenChange={setIsExpanded} className="flex-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Badge variant="default" className="shrink-0">
                      Step {index + 1}
                    </Badge>
                    {step.requiresUserInput && (
                      <Badge variant="outline" className="text-xs">
                        Requires Input
                      </Badge>
                    )}
                    {selectedAgent && (
                      <span className="text-sm text-muted-foreground">
                        {selectedAgent.title}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <CollapsibleTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                        {isExpanded ? (
                          <ChevronDown className="size-4" />
                        ) : (
                          <ChevronRight className="size-4" />
                        )}
                      </Button>
                    </CollapsibleTrigger>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => onRemove(step.id)}
                      className="h-8 w-8 p-0 text-destructive"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>

                <CollapsibleContent className="mt-3 space-y-3">
                  {/* Agent selection */}
                  <div>
                    <Label htmlFor={`agent-${step.id}`}>AI Agent</Label>
                    <Select
                      value={step.agentId}
                      onValueChange={(value) =>
                        onUpdate(step.id, { agentId: value })
                      }
                    >
                      <SelectTrigger id={`agent-${step.id}`}>
                        <SelectValue placeholder="Select an agent..." />
                      </SelectTrigger>
                      <SelectContent>
                        {agents.length === 0 ? (
                          <div className="px-2 py-1.5 text-sm text-muted-foreground">
                            No agents available
                          </div>
                        ) : (
                          agents.map((agent) => (
                            <SelectItem key={agent.id} value={agent.id}>
                              {agent.title}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Prompt template */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <Label htmlFor={`prompt-${step.id}`}>Prompt Template</Label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowHelp(!showHelp)}
                        className="h-6 text-xs"
                      >
                        <Info className="size-3 mr-1" />
                        {showHelp ? 'Hide' : 'Show'} Variables
                      </Button>
                    </div>

                    {showHelp && (
                      <div className="mb-2 p-2 bg-muted rounded-md text-xs space-y-1">
                        <p className="font-semibold">Available variables:</p>
                        <ul className="space-y-0.5 ml-2">
                          <li>
                            <code className="bg-background px-1 py-0.5 rounded">
                              {'{{context}}'}
                            </code>{' '}
                            - Full accumulated context
                          </li>
                          <li>
                            <code className="bg-background px-1 py-0.5 rounded">
                              {'{{initialContext.key}}'}
                            </code>{' '}
                            - Access initial context
                          </li>
                          <li>
                            <code className="bg-background px-1 py-0.5 rounded">
                              {'{{step0.output}}'}
                            </code>{' '}
                            - Output from step 0
                          </li>
                          <li>
                            <code className="bg-background px-1 py-0.5 rounded">
                              {'{{userInput}}'}
                            </code>{' '}
                            - User input from this step
                          </li>
                        </ul>
                      </div>
                    )}

                    <Textarea
                      id={`prompt-${step.id}`}
                      value={step.promptTemplate}
                      onChange={(e) =>
                        onUpdate(step.id, { promptTemplate: e.target.value })
                      }
                      placeholder="Enter the prompt template for this step..."
                      rows={4}
                      className="font-mono text-sm"
                    />
                  </div>

                  {/* Requires user input toggle */}
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id={`requires-input-${step.id}`}
                      checked={step.requiresUserInput}
                      onCheckedChange={(checked) =>
                        onUpdate(step.id, { requiresUserInput: checked === true })
                      }
                    />
                    <Label
                      htmlFor={`requires-input-${step.id}`}
                      className="font-normal"
                    >
                      Requires user input before execution
                    </Label>
                  </div>

                  {/* Input schema builder (conditional) */}
                  {step.requiresUserInput && (
                    <div className="pl-6 border-l-2 border-muted">
                      <WorkflowInputSchemaBuilder
                        schema={step.inputSchema}
                        onChange={(schema) =>
                          onUpdate(step.id, { inputSchema: schema })
                        }
                      />
                    </div>
                  )}
                </CollapsibleContent>
              </Collapsible>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
