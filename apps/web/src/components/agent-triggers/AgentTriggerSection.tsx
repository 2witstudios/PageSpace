'use client';

import { ChevronRight } from 'lucide-react';
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { TriggerPagePicker } from '@/components/layout/middle-content/page-views/task-list/TriggerPagePicker';

export const MAX_CONTEXT_PAGES = 10;

export interface AgentTriggerValue {
  agentPageId: string;
  prompt: string;
  instructionPageId: string | null;
  contextPageIds: string[];
}

export interface AgentTriggerAgent {
  id: string;
  title: string | null;
}

export interface AgentTriggerSectionProps {
  driveId: string;
  agents: AgentTriggerAgent[];
  agentsLoading: boolean;
  value: AgentTriggerValue;
  onChange: (next: AgentTriggerValue) => void;
  promptPlaceholder?: string;
  disabled?: boolean;
}

/**
 * Shared agent / prompt / instruction-page / context-pages form section.
 *
 * Used by both TaskAgentTriggersDialog (per-trigger-type) and
 * EventAgentTriggerDialog (single trigger). Selection state lives entirely in
 * the parent through `value`/`onChange` so this component carries no internal
 * state a remote refetch could clobber. Collapsible "Advanced" matches the
 * task dialog's UX so users see the same affordance in both surfaces.
 */
export function AgentTriggerSection({
  driveId,
  agents,
  agentsLoading,
  value,
  onChange,
  promptPlaceholder,
  disabled,
}: AgentTriggerSectionProps) {
  const advancedCount =
    (value.instructionPageId ? 1 : 0) + value.contextPageIds.length;

  return (
    <div className="space-y-3 pt-1">
      <div className="space-y-2">
        <Label>Agent</Label>
        <Select
          value={value.agentPageId}
          onValueChange={(v) => onChange({ ...value, agentPageId: v })}
          disabled={agentsLoading || disabled}
        >
          <SelectTrigger>
            <SelectValue placeholder={agentsLoading ? 'Loading agents…' : 'Select an agent'} />
          </SelectTrigger>
          <SelectContent>
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.title ?? 'Untitled agent'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label>Prompt</Label>
        <Textarea
          placeholder={promptPlaceholder ?? 'What should the agent do when this fires?'}
          value={value.prompt}
          onChange={(e) => onChange({ ...value, prompt: e.target.value })}
          rows={3}
          disabled={disabled}
        />
        <p className="text-xs text-muted-foreground">
          Optional when an instruction page is set.
        </p>
      </div>

      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 -ml-2 px-2 text-xs text-muted-foreground hover:text-foreground group"
            disabled={disabled}
          >
            <ChevronRight className="mr-1 h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-90" />
            Advanced
            {advancedCount > 0 && (
              <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium">
                {advancedCount}
              </span>
            )}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-3 pt-2">
          <div className="space-y-2">
            <Label className="text-xs">Instruction page</Label>
            <p className="text-xs text-muted-foreground">
              When set, the page&apos;s body becomes the agent&apos;s instructions when the trigger fires.
            </p>
            <TriggerPagePicker
              mode="single"
              driveId={driveId}
              value={value.instructionPageId}
              onChange={(id) => onChange({ ...value, instructionPageId: id })}
              placeholder="Pick an instruction page…"
              disabled={disabled}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-xs">Context pages</Label>
            <p className="text-xs text-muted-foreground">
              Additional pages the agent can read for context (max {MAX_CONTEXT_PAGES}).
            </p>
            <TriggerPagePicker
              mode="multi"
              driveId={driveId}
              value={value.contextPageIds}
              onChange={(ids) => onChange({ ...value, contextPageIds: ids })}
              placeholder="Add context pages…"
              max={MAX_CONTEXT_PAGES}
              disabled={disabled}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
