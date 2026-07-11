'use client';

import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { TerminalSquare, ArrowUp, ArrowDown, X, Loader2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { fetchWithAuth, put } from '@/lib/auth/auth-fetch';
import type { MachineRef } from '@/lib/repositories/page-agent-repository';

interface AvailableMachine {
  id: string;
  title: string;
}

interface MachineAccessConfig {
  machineAccess: boolean;
  machines: MachineRef[];
  availableMachines: AvailableMachine[];
}

function machineKey(machine: MachineRef): string {
  return machine.kind === 'own' ? 'own' : machine.machineId;
}

export function MachineAccessCard() {
  const [config, setConfig] = useState<MachineAccessConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedMachineId, setSelectedMachineId] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    (async () => {
      try {
        const response = await fetchWithAuth('/api/user/assistant-config');
        if (!response.ok) throw new Error('Failed to load config');
        const json = await response.json();
        if (!cancelled) {
          setConfig({
            machineAccess: json.config.machineAccess ?? false,
            machines: json.config.machines ?? [],
            availableMachines: json.config.availableMachines ?? [],
          });
        }
      } catch (error) {
        console.error('Failed to load machine access config:', error);
        if (!cancelled) {
          setLoadError(true);
          toast.error('Failed to load Machine Access settings');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  async function persist(next: { machineAccess: boolean; machines: MachineRef[] }) {
    if (!config) return;
    const previous = config;
    setConfig({ ...config, ...next });
    setSaving(true);
    try {
      await put('/api/user/assistant-config', next);
    } catch (error) {
      setConfig(previous);
      toast.error(error instanceof Error ? error.message : 'Failed to update Machine Access');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="py-6">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </CardContent>
      </Card>
    );
  }

  if (loadError || !config) {
    return (
      <Card>
        <CardContent className="py-6 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">Could not load Machine Access settings.</p>
          <Button type="button" variant="outline" size="sm" onClick={() => setReloadToken((t) => t + 1)}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const usedMachineIds = new Set(
    config.machines.filter((m): m is { kind: 'existing'; machineId: string } => m.kind === 'existing').map((m) => m.machineId),
  );
  const hasOwnMachine = config.machines.some((m) => m.kind === 'own');
  const availableMachinesById = new Map(config.availableMachines.map((t) => [t.id, t]));
  const machineOptions = config.availableMachines.filter((t) => !usedMachineIds.has(t.id));

  function moveMachine(index: number, nextIndex: number) {
    if (!config || nextIndex < 0 || nextIndex >= config.machines.length) return;
    const machines = [...config.machines];
    [machines[index], machines[nextIndex]] = [machines[nextIndex], machines[index]];
    persist({ machineAccess: config.machineAccess, machines });
  }

  function removeMachine(index: number) {
    if (!config) return;
    const machines = config.machines.filter((_, i) => i !== index);
    persist({ machineAccess: config.machineAccess, machines });
  }

  function addOwnMachine() {
    if (!config) return;
    persist({ machineAccess: config.machineAccess, machines: [...config.machines, { kind: 'own' }] });
  }

  function addExistingMachine() {
    if (!config || !selectedMachineId) return;
    persist({
      machineAccess: config.machineAccess,
      machines: [...config.machines, { kind: 'existing', machineId: selectedMachineId }],
    });
    setSelectedMachineId('');
  }

  function toggleMachineAccess(checked: boolean) {
    if (!config) return;
    const machines = checked && config.machines.length === 0 ? [{ kind: 'own' as const }] : config.machines;
    persist({ machineAccess: checked, machines });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TerminalSquare className="h-5 w-5" />
            <div>
              <CardTitle className="text-lg">Machine Access</CardTitle>
              <CardDescription>
                Let the global assistant run commands on a persistent Machine and move between Machines.
              </CardDescription>
            </div>
          </div>
          <Switch checked={config.machineAccess} disabled={saving} onCheckedChange={toggleMachineAccess} />
        </div>
      </CardHeader>
      {config.machineAccess && (
        <CardContent className="space-y-4">
          <Alert variant="warning">
            <TriangleAlert />
            <AlertTitle>Broad input surface + shell access</AlertTitle>
            <AlertDescription>
              The global assistant already has unrestricted access to external content — web search, page
              fetching, calendar — plus any integrations you connect (GitHub, Notion, Slack). Machine Access
              adds the ability to run shell commands on a persistent Machine using that same input surface.
              PageSpace flags suspicious tool output but does not block it — review what the assistant does with
              content fetched from outside sources.
            </AlertDescription>
          </Alert>
          <div>
            <label className="text-sm font-medium mb-2 block">Machines</label>
            <p className="text-xs text-muted-foreground mb-3">
              The assistant moves between these with switch_machine. The first Machine is the default active one.
            </p>
            {config.machines.length === 0 ? (
              <p className="text-sm text-muted-foreground">No machines configured yet.</p>
            ) : (
              <div className="space-y-2">
                {config.machines.map((machine, index) => {
                  const label = machine.kind === 'own'
                    ? 'Own machine'
                    : availableMachinesById.get(machine.machineId)?.title ?? 'Unknown machine';
                  return (
                    <div
                      key={machineKey(machine)}
                      className="flex items-center justify-between rounded-lg border px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        {index === 0 && <Badge variant="outline">Default</Badge>}
                        <span className="text-sm font-medium">{label}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={saving || index === 0}
                          onClick={() => moveMachine(index, index - 1)}
                          aria-label="Move machine up"
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={saving || index === config.machines.length - 1}
                          onClick={() => moveMachine(index, index + 1)}
                          aria-label="Move machine down"
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={saving}
                          onClick={() => removeMachine(index)}
                          aria-label="Remove machine"
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={saving || hasOwnMachine} onClick={addOwnMachine}>
              Add own machine
            </Button>
            <Select value={selectedMachineId} onValueChange={setSelectedMachineId} disabled={saving || machineOptions.length === 0}>
              <SelectTrigger className="h-8 w-56 text-sm">
                <SelectValue placeholder={machineOptions.length === 0 ? 'No more machines to add' : 'Use existing machine…'} />
              </SelectTrigger>
              <SelectContent>
                {machineOptions.map((machine) => (
                  <SelectItem key={machine.id} value={machine.id}>
                    {machine.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="button" size="sm" disabled={saving || !selectedMachineId} onClick={addExistingMachine}>
              Add
            </Button>
            {saving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
        </CardContent>
      )}
    </Card>
  );
}
