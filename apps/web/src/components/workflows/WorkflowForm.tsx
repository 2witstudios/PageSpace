'use client';

import { useState, useEffect, type FormEvent } from 'react';
import useSWR from 'swr';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { getHumanReadableCron } from '@/lib/workflows/cron-utils';
import type { EventTrigger } from './types';

interface WorkflowFormData {
  name: string;
  agentPageId: string;
  prompt: string;
  contextPageIds: string[];
  triggerType: 'cron' | 'event';
  cronExpression?: string;
  timezone: string;
  isEnabled: boolean;
  eventTriggers?: EventTrigger[];
  watchedFolderIds?: string[];
  eventDebounceSecs?: number;
}

interface AgentPage {
  id: string;
  title: string;
  type: string;
}

interface WorkflowFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  driveId: string;
  initialData?: Partial<WorkflowFormData> & { id?: string };
  onSubmit: (data: WorkflowFormData) => Promise<void>;
}

const CRON_PRESETS = [
  { label: 'Every 5 minutes', value: '*/5 * * * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Daily at 9am', value: '0 9 * * *' },
  { label: 'Weekdays at 9am', value: '0 9 * * 1-5' },
  { label: 'Weekly on Monday', value: '0 9 * * 1' },
  { label: 'Monthly on 1st', value: '0 9 1 * *' },
];

const EVENT_TRIGGER_PRESETS: { label: string; description: string; operation: string; resourceType: string }[] = [
  { label: 'Page created', description: 'When a new page is created', operation: 'create', resourceType: 'page' },
  { label: 'File uploaded', description: 'When a file is uploaded', operation: 'upload', resourceType: 'file' },
  { label: 'Page moved', description: 'When a page is moved to a folder', operation: 'move', resourceType: 'page' },
  { label: 'Member added', description: 'When a new member joins the drive', operation: 'member_add', resourceType: 'member' },
];

const fetcher = (url: string) => fetch(url).then(res => res.json());

export function WorkflowForm({ open, onOpenChange, driveId, initialData, onSubmit }: WorkflowFormProps) {
  const [name, setName] = useState(initialData?.name ?? '');
  const [agentPageId, setAgentPageId] = useState(initialData?.agentPageId ?? '');
  const [prompt, setPrompt] = useState(initialData?.prompt ?? '');
  const [triggerType, setTriggerType] = useState<'cron' | 'event'>(initialData?.triggerType ?? 'cron');
  const [cronExpression, setCronExpression] = useState(initialData?.cronExpression ?? '0 9 * * 1-5');
  const [timezone, setTimezone] = useState(initialData?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [isEnabled, setIsEnabled] = useState(initialData?.isEnabled ?? true);
  const [eventTriggers, setEventTriggers] = useState<EventTrigger[]>(initialData?.eventTriggers ?? []);
  const [eventDebounceSecs, setEventDebounceSecs] = useState(initialData?.eventDebounceSecs ?? 30);
  const [cronPreview, setCronPreview] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Fetch agent pages in this drive
  const { data: pagesData } = useSWR<AgentPage[]>(
    open ? `/api/workflows/agents?driveId=${driveId}` : null,
    fetcher
  );

  const agents = pagesData ?? [];

  // Fetch human-readable cron preview using cronstrue
  useEffect(() => {
    if (!cronExpression) {
      setCronPreview('');
      return;
    }
    setCronPreview(getHumanReadableCron(cronExpression));
  }, [cronExpression]);

  // Reset form when dialog opens with new data
  useEffect(() => {
    if (open) {
      setName(initialData?.name ?? '');
      setAgentPageId(initialData?.agentPageId ?? '');
      setPrompt(initialData?.prompt ?? '');
      setTriggerType(initialData?.triggerType ?? 'cron');
      setCronExpression(initialData?.cronExpression ?? '0 9 * * 1-5');
      setTimezone(initialData?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
      setIsEnabled(initialData?.isEnabled ?? true);
      setEventTriggers(initialData?.eventTriggers ?? []);
      setEventDebounceSecs(initialData?.eventDebounceSecs ?? 30);
      setError('');
    }
  }, [open, initialData]);

  const toggleEventTrigger = (operation: string, resourceType: string) => {
    setEventTriggers(prev => {
      const exists = prev.some(t => t.operation === operation && t.resourceType === resourceType);
      if (exists) {
        return prev.filter(t => !(t.operation === operation && t.resourceType === resourceType));
      }
      return [...prev, { operation, resourceType }];
    });
  };

  const isEventTriggerSelected = (operation: string, resourceType: string) => {
    return eventTriggers.some(t => t.operation === operation && t.resourceType === resourceType);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);

    try {
      await onSubmit({
        name,
        agentPageId,
        prompt,
        contextPageIds: [],
        triggerType,
        cronExpression: triggerType === 'cron' ? cronExpression : undefined,
        timezone,
        isEnabled,
        eventTriggers: triggerType === 'event' ? eventTriggers : undefined,
        eventDebounceSecs: triggerType === 'event' ? eventDebounceSecs : undefined,
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save workflow');
    } finally {
      setIsSubmitting(false);
    }
  };

  const isTimezoneValid = (() => {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
      return true;
    } catch {
      return false;
    }
  })();

  const isValid = name && agentPageId && prompt && isTimezoneValid && (
    triggerType === 'cron' ? !!cronExpression : eventTriggers.length > 0
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initialData?.id ? 'Edit Workflow' : 'Create Workflow'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="wf-name">Name</Label>
            <Input
              id="wf-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Daily report generation"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="wf-agent">AI Agent</Label>
            {agents.length === 0 && pagesData ? (
              <p className="text-sm text-muted-foreground py-2">
                No AI agents in this drive. Create an AI Chat page first.
              </p>
            ) : (
              <Select value={agentPageId} onValueChange={setAgentPageId} required>
                <SelectTrigger id="wf-agent">
                  <SelectValue placeholder="Select an agent..." />
                </SelectTrigger>
                <SelectContent>
                  {agents.map(agent => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="wf-prompt">Prompt</Label>
            <Textarea
              id="wf-prompt"
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="Write a daily summary report referencing the meeting notes..."
              rows={4}
              required
            />
          </div>

          {/* Trigger Type Toggle */}
          <div className="space-y-2">
            <Label>Trigger Type</Label>
            <div className="flex rounded-md border overflow-hidden">
              <button
                type="button"
                className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
                  triggerType === 'cron'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted/50 hover:bg-muted'
                }`}
                onClick={() => setTriggerType('cron')}
              >
                Schedule (Cron)
              </button>
              <button
                type="button"
                className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
                  triggerType === 'event'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted/50 hover:bg-muted'
                }`}
                onClick={() => setTriggerType('event')}
              >
                Event Trigger
              </button>
            </div>
          </div>

          {/* Cron Schedule Fields */}
          {triggerType === 'cron' && (
            <div className="space-y-2">
              <Label htmlFor="wf-cron">Schedule (Cron Expression)</Label>
              <Input
                id="wf-cron"
                value={cronExpression}
                onChange={e => setCronExpression(e.target.value)}
                placeholder="0 9 * * 1-5"
                required
              />
              {cronPreview && (
                <p className="text-xs text-muted-foreground">{cronPreview}</p>
              )}
              <div className="flex flex-wrap gap-1.5">
                {CRON_PRESETS.map(preset => (
                  <Button
                    key={preset.value}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-6 text-xs px-2"
                    onClick={() => setCronExpression(preset.value)}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {/* Event Trigger Fields */}
          {triggerType === 'event' && (
            <>
              <div className="space-y-2">
                <Label>When these events happen</Label>
                <div className="space-y-1.5">
                  {EVENT_TRIGGER_PRESETS.map(preset => (
                    <label
                      key={`${preset.operation}-${preset.resourceType}`}
                      className="flex items-start gap-2 p-2 rounded-md border cursor-pointer hover:bg-muted/50 transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={isEventTriggerSelected(preset.operation, preset.resourceType)}
                        onChange={() => toggleEventTrigger(preset.operation, preset.resourceType)}
                        className="mt-0.5 rounded"
                      />
                      <div>
                        <div className="text-sm font-medium">{preset.label}</div>
                        <div className="text-xs text-muted-foreground">{preset.description}</div>
                      </div>
                    </label>
                  ))}
                </div>
                {eventTriggers.length === 0 && (
                  <p className="text-xs text-destructive">Select at least one event trigger</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="wf-debounce">Debounce (seconds)</Label>
                <Input
                  id="wf-debounce"
                  type="number"
                  min={5}
                  max={3600}
                  value={eventDebounceSecs}
                  onChange={e => setEventDebounceSecs(Number(e.target.value))}
                />
                <p className="text-xs text-muted-foreground">
                  Wait this long after the first event before running. Coalesces rapid events (e.g., bulk uploads) into a single run.
                </p>
              </div>
            </>
          )}

          <div className="space-y-2">
            <Label htmlFor="wf-tz">Timezone</Label>
            <Input
              id="wf-tz"
              list="tz-options"
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
              placeholder="America/New_York"
            />
            <datalist id="tz-options">
              <option value="UTC" />
              <option value="America/New_York" />
              <option value="America/Chicago" />
              <option value="America/Denver" />
              <option value="America/Los_Angeles" />
              <option value="America/Anchorage" />
              <option value="Pacific/Honolulu" />
              <option value="America/Toronto" />
              <option value="America/Vancouver" />
              <option value="America/Sao_Paulo" />
              <option value="America/Mexico_City" />
              <option value="Europe/London" />
              <option value="Europe/Paris" />
              <option value="Europe/Berlin" />
              <option value="Europe/Amsterdam" />
              <option value="Europe/Madrid" />
              <option value="Europe/Rome" />
              <option value="Europe/Zurich" />
              <option value="Europe/Stockholm" />
              <option value="Europe/Moscow" />
              <option value="Asia/Dubai" />
              <option value="Asia/Kolkata" />
              <option value="Asia/Shanghai" />
              <option value="Asia/Tokyo" />
              <option value="Asia/Seoul" />
              <option value="Asia/Singapore" />
              <option value="Asia/Hong_Kong" />
              <option value="Australia/Sydney" />
              <option value="Australia/Melbourne" />
              <option value="Pacific/Auckland" />
            </datalist>
            {timezone && !isTimezoneValid && (
              <p className="text-xs text-destructive">Invalid timezone. Select from the list or enter a valid IANA timezone.</p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Switch
              id="wf-enabled"
              checked={isEnabled}
              onCheckedChange={setIsEnabled}
            />
            <Label htmlFor="wf-enabled">Enabled</Label>
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || !isValid}>
              {isSubmitting ? 'Saving...' : (initialData?.id ? 'Update' : 'Create')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
