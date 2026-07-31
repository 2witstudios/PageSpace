'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp, Trash2, Plus, Braces, Sparkles, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * Mirrors packages/db/src/schema/workflows.ts's WorkflowStep union. Declared
 * locally (type-only, no runtime import) — client components in this repo
 * don't import from @pagespace/db/schema.
 */
export type WorkflowAiStep = { kind: 'ai'; prompt: string; agentPageId?: string };
export type WorkflowToolStep = { kind: 'tool'; toolName: string; args: Record<string, unknown> };
export type WorkflowStep = WorkflowAiStep | WorkflowToolStep;

export function isPayloadRef(value: unknown): value is { $payload: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    '$payload' in value &&
    typeof (value as { $payload: unknown }).$payload === 'string'
  );
}

type FieldType = 'text' | 'textarea' | 'number' | 'select';

interface ToolFieldSpec {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  /** String fields whose value may come from the triggering webhook payload. */
  allowRef?: boolean;
  options?: readonly string[];
  placeholder?: string;
}

/**
 * Hand-written arg forms for the deterministic tool allowlist
 * (apps/web/src/lib/ai/core/deterministic-tools.ts). Zod-schema introspection
 * was considered and rejected as over-engineering for six tools — this list
 * must be kept in sync with DETERMINISTIC_TOOL_ALLOWLIST by hand.
 */
const TOOL_FIELD_SPECS: Record<string, { label: string; fields: ToolFieldSpec[] }> = {
  insert_content: {
    label: 'Insert content into a page',
    fields: [
      { key: 'title', label: 'Title (for display in logs)', type: 'text', required: true, allowRef: true, placeholder: 'e.g. Status Doc' },
      { key: 'pageId', label: 'Page ID', type: 'text', required: true, allowRef: true, placeholder: 'e.g. xk3n9p2q...' },
      { key: 'anchor', label: 'Anchor text', type: 'text', required: true, allowRef: true, placeholder: 'e.g. ## Log' },
      { key: 'position', label: 'Position', type: 'select', options: ['before', 'after'], required: true },
      { key: 'content', label: 'Content', type: 'textarea', required: true, allowRef: true },
    ],
  },
  replace_lines: {
    label: 'Replace lines in a page',
    fields: [
      { key: 'title', label: 'Title (for display in logs)', type: 'text', required: true, allowRef: true },
      { key: 'pageId', label: 'Page ID', type: 'text', required: true, allowRef: true },
      { key: 'startLine', label: 'Start line', type: 'number', required: true },
      { key: 'endLine', label: 'End line (optional)', type: 'number' },
      { key: 'content', label: 'Content', type: 'textarea', required: true, allowRef: true },
    ],
  },
  create_page: {
    label: 'Create a page',
    fields: [
      { key: 'parentId', label: 'Parent page ID (optional)', type: 'text', allowRef: true },
      { key: 'title', label: 'Title', type: 'text', required: true, allowRef: true },
      {
        key: 'type',
        label: 'Page type',
        type: 'select',
        required: true,
        options: ['FOLDER', 'DOCUMENT', 'CHANNEL', 'CANVAS', 'SHEET', 'TASK_LIST', 'CODE'],
      },
      { key: 'contentMode', label: 'Content mode (DOCUMENT only)', type: 'select', options: ['html', 'markdown'] },
    ],
  },
  send_channel_message: {
    label: 'Post a channel message',
    fields: [
      { key: 'channelId', label: 'Channel page ID', type: 'text', required: true, allowRef: true },
      { key: 'content', label: 'Message', type: 'textarea', required: true, allowRef: true },
    ],
  },
  create_task: {
    label: 'Create a task',
    fields: [
      { key: 'pageId', label: 'Task list page ID', type: 'text', required: true, allowRef: true },
      { key: 'title', label: 'Title', type: 'text', required: true, allowRef: true },
      { key: 'status', label: 'Status slug (optional)', type: 'text', allowRef: true },
      { key: 'priority', label: 'Priority (optional)', type: 'select', options: ['low', 'medium', 'high'] },
      { key: 'assigneeId', label: 'Assignee user ID (optional)', type: 'text', allowRef: true },
    ],
  },
  update_task: {
    label: 'Update a task',
    fields: [
      { key: 'taskId', label: 'Task ID', type: 'text', required: true, allowRef: true },
      { key: 'title', label: 'New title (optional)', type: 'text', allowRef: true },
      { key: 'status', label: 'New status slug (optional)', type: 'text', allowRef: true },
      { key: 'priority', label: 'Priority (optional)', type: 'select', options: ['low', 'medium', 'high'] },
    ],
  },
};

export const DETERMINISTIC_TOOL_NAMES = Object.keys(TOOL_FIELD_SPECS);

/** True when every required field of a tool step has a value (literal or a payload reference). */
export function isToolStepComplete(step: WorkflowToolStep): boolean {
  const spec = TOOL_FIELD_SPECS[step.toolName];
  if (!spec) return false;
  return spec.fields
    .filter((field) => field.required)
    .every((field) => {
      const value = step.args[field.key];
      if (isPayloadRef(value)) return value.$payload.trim().length > 0;
      return value !== undefined && value !== null && String(value).trim().length > 0;
    });
}

/** True when a step chain is submittable: non-empty, every step complete. */
export function isStepsValid(steps: WorkflowStep[]): boolean {
  if (steps.length === 0) return false;
  return steps.every((step) =>
    step.kind === 'ai' ? step.prompt.trim().length > 0 : isToolStepComplete(step)
  );
}

/**
 * Legacy prompt+agentPageId workflows (steps null/empty) synthesize one ai
 * step — identical to the executor's resolveSteps() so the form shows
 * exactly what will run.
 */
export function synthesizeSteps(row: {
  steps: WorkflowStep[] | null;
  prompt: string;
  agentPageId: string | null;
}): WorkflowStep[] {
  if (row.steps && row.steps.length > 0) return row.steps;
  if (!row.prompt && !row.agentPageId) return [];
  return [
    { kind: 'ai', prompt: row.prompt, ...(row.agentPageId ? { agentPageId: row.agentPageId } : {}) },
  ];
}

interface AgentPage {
  id: string;
  title: string;
}

interface WorkflowStepsEditorProps {
  steps: WorkflowStep[];
  onChange: (steps: WorkflowStep[]) => void;
  agents: AgentPage[];
}

function emptyToolArgs(toolName: string): Record<string, unknown> {
  const spec = TOOL_FIELD_SPECS[toolName];
  const args: Record<string, unknown> = {};
  for (const field of spec?.fields ?? []) {
    if (field.type === 'select' && field.options?.length && field.required) {
      args[field.key] = field.options[0];
    }
  }
  return args;
}

function ToolArgField({
  field,
  value,
  onChange,
}: {
  field: ToolFieldSpec;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const usingRef = field.allowRef && isPayloadRef(value);

  if (usingRef) {
    const path = (value as { $payload: string }).$payload;
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label className="text-xs">{field.label}</Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-5 text-[10px] px-1.5"
            onClick={() => onChange('')}
          >
            Use static value
          </Button>
        </div>
        <div className="flex items-center gap-1.5">
          <Braces className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <Input
            value={path}
            onChange={(e) => onChange({ $payload: e.target.value })}
            placeholder="e.g. issue.title"
            className="h-7 text-xs font-mono"
          />
        </div>
        <p className="text-[10px] text-muted-foreground">
          Resolved from the triggering webhook&apos;s payload at run time.
        </p>
      </div>
    );
  }

  const stringValue = typeof value === 'string' || typeof value === 'number' ? String(value) : '';

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{field.label}</Label>
        {field.allowRef && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-5 text-[10px] px-1.5 gap-1"
            onClick={() => onChange({ $payload: '' })}
          >
            <Braces className="h-3 w-3" />
            Use payload reference
          </Button>
        )}
      </div>
      {field.type === 'textarea' ? (
        <Textarea
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          rows={3}
          className="text-xs"
        />
      ) : field.type === 'number' ? (
        <Input
          type="number"
          value={stringValue}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          className="h-7 text-xs"
        />
      ) : field.type === 'select' ? (
        <Select value={stringValue || undefined} onValueChange={onChange}>
          <SelectTrigger className="h-7 text-xs">
            <SelectValue placeholder="Select..." />
          </SelectTrigger>
          <SelectContent>
            {field.options?.map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className="h-7 text-xs"
        />
      )}
    </div>
  );
}

function StepEditor({
  step,
  onChange,
  agents,
}: {
  step: WorkflowStep;
  onChange: (step: WorkflowStep) => void;
  agents: AgentPage[];
}) {
  if (step.kind === 'ai') {
    return (
      <div className="space-y-2">
        <div className="space-y-1">
          <Label className="text-xs">Agent (optional — defaults to the workflow&apos;s agent)</Label>
          <Select
            value={step.agentPageId ?? '__default__'}
            onValueChange={(v) => onChange({ ...step, agentPageId: v === '__default__' ? undefined : v })}
          >
            <SelectTrigger className="h-7 text-xs">
              <SelectValue placeholder="Use workflow default" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">Use workflow default</SelectItem>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Prompt</Label>
          <Textarea
            value={step.prompt}
            onChange={(e) => onChange({ ...step, prompt: e.target.value })}
            rows={3}
            placeholder="Write a daily summary report..."
            className="text-xs"
          />
        </div>
      </div>
    );
  }

  const spec = TOOL_FIELD_SPECS[step.toolName];
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label className="text-xs">Tool</Label>
        <Select
          value={step.toolName}
          onValueChange={(toolName) => onChange({ kind: 'tool', toolName, args: emptyToolArgs(toolName) })}
        >
          <SelectTrigger className="h-7 text-xs">
            <SelectValue placeholder="Select a tool..." />
          </SelectTrigger>
          <SelectContent>
            {DETERMINISTIC_TOOL_NAMES.map((name) => (
              <SelectItem key={name} value={name}>
                {TOOL_FIELD_SPECS[name].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {spec?.fields.map((field) => (
        <ToolArgField
          key={field.key}
          field={field}
          value={step.args[field.key]}
          onChange={(value) => onChange({ ...step, args: { ...step.args, [field.key]: value } })}
        />
      ))}
    </div>
  );
}

export function WorkflowStepsEditor({ steps, onChange, agents }: WorkflowStepsEditorProps) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set(steps.length > 0 ? [0] : []));

  const toggleExpanded = (index: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const updateStep = (index: number, step: WorkflowStep) => {
    onChange(steps.map((s, i) => (i === index ? step : s)));
  };

  const removeStep = (index: number) => {
    onChange(steps.filter((_, i) => i !== index));
    // expanded tracks expand/collapse by array index — without remapping,
    // every index above the removed one points at the wrong step.
    setExpanded((prev) => {
      const next = new Set<number>();
      prev.forEach((i) => {
        if (i < index) next.add(i);
        else if (i > index) next.add(i - 1);
      });
      return next;
    });
  };

  const moveStep = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
    // Swap the expand/collapse flags along with the steps so the flag
    // follows the step, not the array slot it used to occupy.
    setExpanded((prev) => {
      const hasIndex = prev.has(index);
      const hasTarget = prev.has(target);
      const nextExpanded = new Set(prev);
      nextExpanded.delete(index);
      nextExpanded.delete(target);
      if (hasIndex) nextExpanded.add(target);
      if (hasTarget) nextExpanded.add(index);
      return nextExpanded;
    });
  };

  const addStep = (kind: 'ai' | 'tool') => {
    const step: WorkflowStep =
      kind === 'ai'
        ? { kind: 'ai', prompt: '' }
        : { kind: 'tool', toolName: DETERMINISTIC_TOOL_NAMES[0], args: emptyToolArgs(DETERMINISTIC_TOOL_NAMES[0]) };
    onChange([...steps, step]);
    setExpanded((prev) => new Set(prev).add(steps.length));
  };

  return (
    <div className="space-y-2">
      {steps.map((step, index) => (
        <div key={index} className="rounded-lg border bg-card">
          <div className="flex items-center gap-2 p-2">
            <button
              type="button"
              onClick={() => toggleExpanded(index)}
              className="flex items-center gap-2 flex-1 min-w-0 text-left"
            >
              <Badge variant={step.kind === 'ai' ? 'default' : 'secondary'} className="shrink-0 gap-1 font-normal">
                {step.kind === 'ai' ? <Sparkles className="h-3 w-3" /> : <Wrench className="h-3 w-3" />}
                {index + 1}. {step.kind === 'ai' ? 'AI' : TOOL_FIELD_SPECS[step.toolName]?.label ?? step.toolName}
              </Badge>
              <span className="text-xs text-muted-foreground truncate">
                {step.kind === 'ai' ? step.prompt || 'No prompt yet' : ''}
              </span>
            </button>
            <div className="flex items-center gap-0.5 shrink-0">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                disabled={index === 0}
                onClick={() => moveStep(index, -1)}
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                disabled={index === steps.length - 1}
                onClick={() => moveStep(index, 1)}
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-destructive"
                onClick={() => removeStep(index)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          {expanded.has(index) && (
            <div className="border-t p-3">
              <StepEditor step={step} onChange={(s) => updateStep(index, s)} agents={agents} />
            </div>
          )}
        </div>
      ))}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="gap-1.5">
            <Plus className="h-3.5 w-3.5" />
            Add step
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => addStep('ai')}>
            <Sparkles className="h-3.5 w-3.5 mr-2" />
            AI step
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => addStep('tool')}>
            <Wrench className="h-3.5 w-3.5 mr-2" />
            Tool step (deterministic, no AI cost)
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {steps.length === 0 && (
        <p className="text-xs text-muted-foreground py-2">
          Add at least one step. AI steps run a prompt against an agent; tool steps invoke a
          PageSpace action directly with no AI cost.
        </p>
      )}
    </div>
  );
}
