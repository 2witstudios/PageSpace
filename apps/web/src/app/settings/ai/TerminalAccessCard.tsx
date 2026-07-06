'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { TerminalSquare, ArrowUp, ArrowDown, X, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { fetchWithAuth, put } from '@/lib/auth/auth-fetch';
import type { MachineRef } from '@/lib/repositories/page-agent-repository';

interface AvailableTerminal {
  id: string;
  title: string;
}

interface TerminalAccessConfig {
  terminalAccess: boolean;
  machines: MachineRef[];
  availableTerminals: AvailableTerminal[];
}

function machineKey(machine: MachineRef): string {
  return machine.kind === 'own' ? 'own' : machine.terminalId;
}

export function TerminalAccessCard() {
  const [config, setConfig] = useState<TerminalAccessConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedTerminalId, setSelectedTerminalId] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetchWithAuth('/api/user/assistant-config');
        if (!response.ok) throw new Error('Failed to load config');
        const json = await response.json();
        if (!cancelled) {
          setConfig({
            terminalAccess: json.config.terminalAccess ?? false,
            machines: json.config.machines ?? [],
            availableTerminals: json.config.availableTerminals ?? [],
          });
        }
      } catch (error) {
        console.error('Failed to load terminal access config:', error);
        if (!cancelled) toast.error('Failed to load Terminal Access settings');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function persist(next: { terminalAccess: boolean; machines: MachineRef[] }) {
    if (!config) return;
    const previous = config;
    setConfig({ ...config, ...next });
    setSaving(true);
    try {
      await put('/api/user/assistant-config', next);
    } catch (error) {
      setConfig(previous);
      toast.error(error instanceof Error ? error.message : 'Failed to update Terminal Access');
    } finally {
      setSaving(false);
    }
  }

  if (loading || !config) {
    return (
      <Card>
        <CardContent className="py-6">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </CardContent>
      </Card>
    );
  }

  const usedTerminalIds = new Set(
    config.machines.filter((m): m is { kind: 'existing'; terminalId: string } => m.kind === 'existing').map((m) => m.terminalId),
  );
  const hasOwnMachine = config.machines.some((m) => m.kind === 'own');
  const availableTerminalsById = new Map(config.availableTerminals.map((t) => [t.id, t]));
  const terminalOptions = config.availableTerminals.filter((t) => !usedTerminalIds.has(t.id));

  function moveMachine(index: number, nextIndex: number) {
    if (!config || nextIndex < 0 || nextIndex >= config.machines.length) return;
    const machines = [...config.machines];
    [machines[index], machines[nextIndex]] = [machines[nextIndex], machines[index]];
    persist({ terminalAccess: config.terminalAccess, machines });
  }

  function removeMachine(index: number) {
    if (!config) return;
    const machines = config.machines.filter((_, i) => i !== index);
    persist({ terminalAccess: config.terminalAccess, machines });
  }

  function addOwnMachine() {
    if (!config) return;
    persist({ terminalAccess: config.terminalAccess, machines: [...config.machines, { kind: 'own' }] });
  }

  function addExistingMachine() {
    if (!config || !selectedTerminalId) return;
    persist({
      terminalAccess: config.terminalAccess,
      machines: [...config.machines, { kind: 'existing', terminalId: selectedTerminalId }],
    });
    setSelectedTerminalId('');
  }

  function toggleTerminalAccess(checked: boolean) {
    if (!config) return;
    const machines = checked && config.machines.length === 0 ? [{ kind: 'own' as const }] : config.machines;
    persist({ terminalAccess: checked, machines });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TerminalSquare className="h-5 w-5" />
            <div>
              <CardTitle className="text-lg">Terminal Access</CardTitle>
              <CardDescription>
                Let the global assistant run commands on a persistent Machine and move between Machines.
              </CardDescription>
            </div>
          </div>
          <Switch checked={config.terminalAccess} disabled={saving} onCheckedChange={toggleTerminalAccess} />
        </div>
      </CardHeader>
      {config.terminalAccess && (
        <CardContent className="space-y-4">
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
                    : availableTerminalsById.get(machine.terminalId)?.title ?? 'Unknown terminal';
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
            <Select value={selectedTerminalId} onValueChange={setSelectedTerminalId} disabled={saving || terminalOptions.length === 0}>
              <SelectTrigger className="h-8 w-56 text-sm">
                <SelectValue placeholder={terminalOptions.length === 0 ? 'No more terminals to add' : 'Use existing machine…'} />
              </SelectTrigger>
              <SelectContent>
                {terminalOptions.map((terminal) => (
                  <SelectItem key={terminal.id} value={terminal.id}>
                    {terminal.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="button" size="sm" disabled={saving || !selectedTerminalId} onClick={addExistingMachine}>
              Add
            </Button>
            {saving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
        </CardContent>
      )}
    </Card>
  );
}
