'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Bot, Zap } from 'lucide-react';
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
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { fetchWithAuth, put, del } from '@/lib/auth/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';
import { useEditingSession } from '@/stores/useEditingSession';
import {
  AgentTriggerSection,
  type AgentTriggerValue,
  type AgentTriggerAgent,
} from '@/components/agent-triggers/AgentTriggerSection';

interface EventTriggerRow {
  id: string;
  agentPageId: string;
  prompt: string | null;
  instructionPageId: string | null;
  contextPageIds: string[] | null;
  lastFiredAt: string | null;
  lastFireError: string | null;
  lastRunStatus: 'running' | 'success' | 'error' | 'cancelled' | null;
}

type LastRunStatus = 'never_run' | 'success' | 'error';

const lastRunStatusFor = (row: EventTriggerRow): LastRunStatus =>
  row.lastFiredAt === null
    ? 'never_run'
    : row.lastFireError
      ? 'error'
      : 'success';

const statusToneClass = (status: LastRunStatus) =>
  status === 'error' ? 'text-xs text-destructive' : 'text-xs text-muted-foreground';

interface EventAgentTriggerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eventId: string;
  eventTitle: string;
  driveId: string;
  onSaved?: () => void;
}

const EMPTY_VALUE: AgentTriggerValue = {
  agentPageId: '',
  prompt: '',
  instructionPageId: null,
  contextPageIds: [],
};

const triggerFetcher = async (url: string): Promise<{ trigger: EventTriggerRow | null }> => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error('Failed to load trigger');
  return res.json();
};

const agentsFetcher = async (url: string): Promise<{ agents: AgentTriggerAgent[] }> => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error('Failed to load agents');
  return res.json();
};

export function EventAgentTriggerDialog({
  open,
  onOpenChange,
  eventId,
  eventTitle,
  driveId,
  onSaved,
}: EventAgentTriggerDialogProps) {
  const triggerKey = open ? `/api/calendar/events/${eventId}/triggers` : null;
  const agentsKey = open && driveId ? `/api/drives/${driveId}/agents` : null;

  const isAnyActive = useEditingStore((s) => s.isAnyActive());
  const triggerLoadedRef = useRef(false);
  const agentsLoadedRef = useRef(false);

  const { data: triggerData, isLoading: triggerLoading, mutate: refetchTrigger } = useSWR(
    triggerKey,
    triggerFetcher,
    {
      revalidateOnFocus: false,
      isPaused: () => triggerLoadedRef.current && isAnyActive,
      onSuccess: () => {
        triggerLoadedRef.current = true;
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

  const [enabled, setEnabled] = useState(false);
  const [value, setValue] = useState<AgentTriggerValue>(EMPTY_VALUE);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  useEditingSession(`event-trigger:${eventId}`, open, 'form', {
    pageId: eventId,
    componentName: 'EventAgentTriggerDialog',
  });

  useEffect(() => {
    if (!open) return;
    const row = triggerData?.trigger ?? null;
    if (row) {
      setEnabled(true);
      setValue({
        agentPageId: row.agentPageId,
        prompt: row.prompt ?? '',
        instructionPageId: row.instructionPageId,
        contextPageIds: row.contextPageIds ?? [],
      });
    } else {
      setEnabled(false);
      setValue(EMPTY_VALUE);
    }
  }, [open, triggerData]);

  const existing = triggerData?.trigger ?? null;
  const existingStatus: LastRunStatus | null = existing ? lastRunStatusFor(existing) : null;

  const noAgents = !agentsLoading && agents.length === 0;

  const handleSave = async () => {
    if (!value.agentPageId) {
      toast.error('Pick an agent first');
      return;
    }
    if (!value.prompt.trim() && !value.instructionPageId) {
      toast.error('Enter a prompt or pick an instruction page');
      return;
    }

    setSaving(true);
    try {
      await put(`/api/calendar/events/${eventId}/triggers`, {
        agentPageId: value.agentPageId,
        prompt: value.prompt.trim() || undefined,
        instructionPageId: value.instructionPageId,
        contextPageIds: value.contextPageIds,
      });
      await refetchTrigger();
      await globalMutate((key: unknown) =>
        typeof key === 'string' && key.startsWith('/api/calendar/events'),
      );
      toast.success('Agent trigger saved');
      onSaved?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save trigger');
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      await del(`/api/calendar/events/${eventId}/triggers`);
      await refetchTrigger();
      await globalMutate((key: unknown) =>
        typeof key === 'string' && key.startsWith('/api/calendar/events'),
      );
      setEnabled(false);
      setValue(EMPTY_VALUE);
      toast.success('Trigger removed');
      onSaved?.();
    } catch {
      toast.error('Failed to remove trigger');
    } finally {
      setRemoving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-amber-500" />
            Agent trigger
          </DialogTitle>
          <DialogDescription className="truncate">
            <span className="font-medium">{eventTitle}</span>
          </DialogDescription>
        </DialogHeader>

        {triggerLoading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : (
          <div className="space-y-4">
            {noAgents && (
              <p className="text-xs text-muted-foreground">
                No agents in this drive. Create an AI Chat page first.
              </p>
            )}

            <div className="space-y-3 rounded-md border p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Bot className="h-4 w-4 text-muted-foreground shrink-0" />
                  <Label className="font-medium cursor-pointer truncate">Run agent at event start</Label>
                </div>
                <Switch
                  checked={enabled}
                  disabled={noAgents}
                  onCheckedChange={setEnabled}
                />
              </div>

              <p className="text-xs text-muted-foreground">
                The agent runs once when the event begins. Reschedule the event to re-aim the trigger.
              </p>

              {enabled && !noAgents && (
                <>
                  <AgentTriggerSection
                    driveId={driveId}
                    agents={agents}
                    agentsLoading={agentsLoading}
                    value={value}
                    onChange={setValue}
                    promptPlaceholder="What should the agent do when this event starts?"
                  />

                  {existingStatus && existingStatus !== 'never_run' && (
                    <p className={statusToneClass(existingStatus)}>
                      {existingStatus === 'error' && (
                        <AlertCircle className="h-3 w-3 inline mr-1" aria-hidden="true" />
                      )}
                      Last run: <span className="font-medium">{existingStatus}</span>
                      {existing?.lastFiredAt
                        ? ` • ${new Date(existing.lastFiredAt).toLocaleString()}`
                        : ''}
                    </p>
                  )}

                  <div className="flex items-center justify-end gap-2">
                    {existing && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={handleRemove}
                        disabled={removing}
                      >
                        {removing ? 'Removing…' : 'Remove'}
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      onClick={handleSave}
                      disabled={saving}
                    >
                      {saving ? 'Saving…' : existing ? 'Update' : 'Save'}
                    </Button>
                  </div>
                </>
              )}
            </div>
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
