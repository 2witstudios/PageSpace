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
import { fetchJSON } from '@/lib/auth/auth-fetch';
import { getHumanReadableCron } from '@/lib/workflows/cron-utils';

interface WorkflowFormData {
  name: string;
  agentPageId: string;
  prompt: string;
  contextPageIds: string[];
  cronExpression: string;
  timezone: string;
  isEnabled: boolean;
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

const fetcher = <T = unknown>(url: string) => fetchJSON<T>(url);

export function WorkflowForm({ open, onOpenChange, driveId, initialData, onSubmit }: WorkflowFormProps) {
  const [name, setName] = useState(initialData?.name ?? '');
  const [agentPageId, setAgentPageId] = useState(initialData?.agentPageId ?? '');
  const [prompt, setPrompt] = useState(initialData?.prompt ?? '');
  const [cronExpression, setCronExpression] = useState(initialData?.cronExpression ?? '0 9 * * 1-5');
  const [timezone, setTimezone] = useState(initialData?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [isEnabled, setIsEnabled] = useState(initialData?.isEnabled ?? true);
  const [contextPageIds, setContextPageIds] = useState<string[]>(initialData?.contextPageIds ?? []);
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
      setCronExpression(initialData?.cronExpression ?? '0 9 * * 1-5');
      setTimezone(initialData?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
      setIsEnabled(initialData?.isEnabled ?? true);
      setContextPageIds(initialData?.contextPageIds ?? []);
      setError('');
    }
  }, [open, initialData]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);

    try {
      await onSubmit({
        name,
        agentPageId,
        prompt,
        contextPageIds,
        cronExpression,
        timezone,
        isEnabled,
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

  const isValid = name && agentPageId && prompt && isTimezoneValid && !!cronExpression;

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
