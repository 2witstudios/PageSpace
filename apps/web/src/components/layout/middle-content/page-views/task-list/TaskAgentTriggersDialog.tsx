'use client';

import { useEffect, useRef, useState } from 'react';
import { Bot, Zap } from 'lucide-react';
import { toast } from 'sonner';
import useSWR, { mutate as globalMutate } from 'swr';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { fetchWithAuth, put, del } from '@/lib/auth/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';
import { useEditingSession } from '@/stores/useEditingSession';

type ApiTriggerType = 'task_due_date' | 'task_completion';
type UiTriggerType = 'due_date' | 'completion';

interface DriveAgent {
  id: string;
  title: string | null;
}

interface TriggerRow {
  id: string;
  triggerType: ApiTriggerType;
  agentPageId: string;
  prompt: string;
  isEnabled: boolean;
  lastRunStatus: 'never_run' | 'success' | 'error' | 'running';
  lastRunAt: string | null;
}

interface TaskAgentTriggersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: string;
  taskTitle: string;
  pageId: string;
  driveId: string;
  hasDueDate: boolean;
  onSaved?: () => void;
}

const TRIGGER_TYPES: { ui: UiTriggerType; api: ApiTriggerType; label: string; help: string }[] = [
  {
    ui: 'due_date',
    api: 'task_due_date',
    label: 'Run when due date arrives',
    help: 'Requires a due date on this task. The agent runs once at the scheduled time.',
  },
  {
    ui: 'completion',
    api: 'task_completion',
    label: 'Run when task is completed',
    help: 'Fires the moment the task is moved to a status in the Done group.',
  },
];

const triggersFetcher = async (url: string): Promise<{ triggers: TriggerRow[] }> => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error('Failed to load triggers');
  return res.json();
};

const agentsFetcher = async (url: string): Promise<{ agents: DriveAgent[] }> => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error('Failed to load agents');
  return res.json();
};

interface SectionState {
  enabled: boolean;
  agentPageId: string;
  prompt: string;
}

const EMPTY_SECTION: SectionState = { enabled: false, agentPageId: '', prompt: '' };

export function TaskAgentTriggersDialog({
  open,
  onOpenChange,
  taskId,
  taskTitle,
  pageId,
  driveId,
  hasDueDate,
  onSaved,
}: TaskAgentTriggersDialogProps) {
  const triggersKey = open ? `/api/tasks/${taskId}/triggers` : null;
  const agentsKey = open && driveId ? `/api/drives/${driveId}/agents` : null;

  // Pause background revalidation while any editing session is active so a remote
  // task_updated broadcast cannot refetch this dialog and clobber in-progress prompt
  // typing. Initial load and explicit mutate() (e.g. refetchTriggers after save) are
  // unaffected because *LoadedRef gates the pause until first success.
  const isAnyActive = useEditingStore((s) => s.isAnyActive());
  const triggersLoadedRef = useRef(false);
  const agentsLoadedRef = useRef(false);

  const { data: triggersData, isLoading: triggersLoading, mutate: refetchTriggers } = useSWR(
    triggersKey,
    triggersFetcher,
    {
      revalidateOnFocus: false,
      isPaused: () => triggersLoadedRef.current && isAnyActive,
      onSuccess: () => {
        triggersLoadedRef.current = true;
      },
    },
  );
  const { data: agentsData, isLoading: agentsLoading } = useSWR(
    agentsKey,
    agentsFetcher,
    {
      revalidateOnFocus: false,
      isPaused: () => agentsLoadedRef.current && isAnyActive,
      onSuccess: () => {
        agentsLoadedRef.current = true;
      },
    },
  );

  const agents = agentsData?.agents ?? [];

  const [sections, setSections] = useState<Record<UiTriggerType, SectionState>>({
    due_date: { ...EMPTY_SECTION },
    completion: { ...EMPTY_SECTION },
  });
  const [savingType, setSavingType] = useState<UiTriggerType | null>(null);
  const [removingType, setRemovingType] = useState<UiTriggerType | null>(null);

  useEditingSession(`task-triggers:${taskId}`, open, 'form', {
    pageId,
    componentName: 'TaskAgentTriggersDialog',
  });

  useEffect(() => {
    if (!open) return;
    const next: Record<UiTriggerType, SectionState> = {
      due_date: { ...EMPTY_SECTION },
      completion: { ...EMPTY_SECTION },
    };
    for (const row of triggersData?.triggers ?? []) {
      const ui: UiTriggerType = row.triggerType === 'task_completion' ? 'completion' : 'due_date';
      next[ui] = {
        enabled: row.isEnabled,
        agentPageId: row.agentPageId,
        prompt: row.prompt ?? '',
      };
    }
    setSections(next);
  }, [open, triggersData]);

  const updateSection = (type: UiTriggerType, patch: Partial<SectionState>) => {
    setSections((prev) => ({ ...prev, [type]: { ...prev[type], ...patch } }));
  };

  const handleSave = async (type: UiTriggerType) => {
    const section = sections[type];
    if (!section.agentPageId) {
      toast.error('Pick an agent first');
      return;
    }
    if (!section.prompt.trim()) {
      toast.error('Enter a prompt for the agent');
      return;
    }
    if (type === 'due_date' && !hasDueDate) {
      toast.error('Set a due date on the task before adding a due-date trigger');
      return;
    }

    setSavingType(type);
    try {
      await put(`/api/tasks/${taskId}/triggers`, {
        triggerType: type,
        agentPageId: section.agentPageId,
        prompt: section.prompt.trim(),
      });
      await refetchTriggers();
      await globalMutate(`/api/pages/${pageId}/tasks`);
      toast.success(type === 'due_date' ? 'Due-date trigger saved' : 'Completion trigger saved');
      onSaved?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save trigger';
      toast.error(msg);
    } finally {
      setSavingType(null);
    }
  };

  const handleRemove = async (type: UiTriggerType) => {
    setRemovingType(type);
    try {
      await del(`/api/tasks/${taskId}/triggers/${type}`);
      await refetchTriggers();
      await globalMutate(`/api/pages/${pageId}/tasks`);
      updateSection(type, { ...EMPTY_SECTION });
      toast.success('Trigger removed');
      onSaved?.();
    } catch {
      toast.error('Failed to remove trigger');
    } finally {
      setRemovingType(null);
    }
  };

  const noAgents = !agentsLoading && agents.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-amber-500" />
            Agent triggers
          </DialogTitle>
          <DialogDescription className="truncate">
            <span className="font-medium">{taskTitle}</span>
          </DialogDescription>
        </DialogHeader>

        {triggersLoading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : (
          <div className="space-y-4">
            {noAgents && (
              <p className="text-xs text-muted-foreground">
                No agents in this drive. Create an AI Chat page first.
              </p>
            )}

            {TRIGGER_TYPES.map(({ ui, label, help }) => {
              const section = sections[ui];
              const existing = (triggersData?.triggers ?? []).find(
                (t) => t.triggerType === (ui === 'completion' ? 'task_completion' : 'task_due_date'),
              );
              const disabled = noAgents || (ui === 'due_date' && !hasDueDate);
              return (
                <div key={ui} className="space-y-3 rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Bot className="h-4 w-4 text-muted-foreground shrink-0" />
                      <Label className="font-medium cursor-pointer truncate">{label}</Label>
                    </div>
                    <Switch
                      checked={section.enabled}
                      disabled={disabled}
                      onCheckedChange={(checked) => updateSection(ui, { enabled: checked })}
                    />
                  </div>

                  <p className="text-xs text-muted-foreground">{help}</p>
                  {ui === 'due_date' && !hasDueDate && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      Add a due date to this task to enable this trigger.
                    </p>
                  )}

                  {section.enabled && !disabled && (
                    <div className="space-y-3 pt-1">
                      <div className="space-y-2">
                        <Label>Agent</Label>
                        <Select
                          value={section.agentPageId}
                          onValueChange={(v) => updateSection(ui, { agentPageId: v })}
                          disabled={agentsLoading}
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
                          placeholder={
                            ui === 'due_date'
                              ? 'What should the agent do when the due date arrives?'
                              : 'What should the agent do when the task is completed?'
                          }
                          value={section.prompt}
                          onChange={(e) => updateSection(ui, { prompt: e.target.value })}
                          rows={3}
                        />
                      </div>

                      {existing?.lastRunStatus && existing.lastRunStatus !== 'never_run' && (
                        <p className={
                          existing.lastRunStatus === 'error'
                            ? 'text-xs text-destructive'
                            : 'text-xs text-muted-foreground'
                        }>
                          Last run: <span className="font-medium">{existing.lastRunStatus}</span>
                          {existing.lastRunAt
                            ? ` • ${new Date(existing.lastRunAt).toLocaleString()}`
                            : ''}
                        </p>
                      )}

                      <div className="flex items-center justify-end gap-2">
                        {existing?.isEnabled && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRemove(ui)}
                            disabled={removingType === ui}
                          >
                            {removingType === ui ? 'Removing…' : 'Remove'}
                          </Button>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => handleSave(ui)}
                          disabled={savingType === ui}
                        >
                          {savingType === ui ? 'Saving…' : existing ? 'Update' : 'Save'}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
