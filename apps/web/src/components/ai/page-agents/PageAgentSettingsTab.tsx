import React, { useState, useEffect, useImperativeHandle, forwardRef, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Loader2, Bot, FolderTree, Shield, Copy, Check, Code2, Wrench, TerminalSquare, ArrowUp, ArrowDown, X } from 'lucide-react';
import { toast } from 'sonner';
import { useForm, useFieldArray, useFormState, Controller } from 'react-hook-form';
import { patch, fetchWithAuth } from '@/lib/auth/auth-fetch';
import Link from 'next/link';
import { AI_PROVIDERS, getVisibleProviders } from '@/lib/ai/core/ai-providers-config';
import { getRoleColorClasses } from '@/lib/utils';
import { AgentDrivesCard } from './AgentDrivesCard';
import { useEditingStore } from '@/stores/useEditingStore';
import type { MachineRef } from '@/lib/repositories/page-agent-repository';

// The Machine tool group: gated behind the Machine Access toggle below and
// hidden from the Default Tools list when access is off. switch_machine/
// list_machines are named ahead of their registration landing in ai-tools.ts
// so this list needs no changes once they ship.
const MACHINE_TOOL_NAMES = new Set(['bash', 'writeFile', 'readFile', 'editFile', 'switch_machine', 'list_machines']);

interface AgentConfig {
  systemPrompt: string;
  enabledTools: string[];
  availableTools: Array<{ name: string; description: string }>;
  aiProvider?: string;
  aiModel?: string;
  includeDrivePrompt?: boolean;
  drivePrompt?: string | null;
  agentDefinition?: string;
  visibleToGlobalAssistant?: boolean;
  includePageTree?: boolean;
  pageTreeScope?: 'children' | 'drive';
  toolExposureMode?: 'upfront' | 'search';
  machineAccess?: boolean;
  machines?: MachineRef[];
  availableMachines?: Array<{ id: string; title: string }>;
}

interface AgentMembership {
  role: string;
  customRole: { id: string; name: string; color: string | null } | null;
}

interface DriveRole {
  id: string;
  name: string;
  color?: string | null;
}

interface PageAgentSettingsTabProps {
  pageId: string;
  driveId: string;
  config: AgentConfig | null;
  onConfigUpdate: (config: AgentConfig) => void;
  selectedProvider: string;
  selectedModel: string;
  onProviderChange: (provider: string) => void;
  onModelChange: (model: string) => void;
  isProviderConfigured: (provider: string) => boolean;
  onSavingChange?: (isSaving: boolean) => void;
}

function ApiModelIdCard({ pageId }: { pageId: string }) {
  const [copied, setCopied] = useState(false);
  const modelId = `ps-agent://${pageId}`;

  const handleCopy = () => {
    navigator.clipboard.writeText(modelId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Code2 className="h-5 w-5" />
          API Model ID
        </CardTitle>
        <CardDescription>
          Use with the OpenAI-compatible API —{' '}
          <Link href="/settings/mcp" className="underline underline-offset-2">
            see MCP Settings for setup
          </Link>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded-md bg-muted px-3 py-2 font-mono text-sm">{modelId}</code>
          <Button type="button" size="sm" variant="outline" onClick={handleCopy}>
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export interface PageAgentSettingsTabRef {
  submitForm: () => void;
  isSaving: boolean;
}

interface FormData {
  systemPrompt: string;
  enabledTools: string[];
  aiProvider: string;
  aiModel: string;
  includeDrivePrompt: boolean;
  agentDefinition: string;
  visibleToGlobalAssistant: boolean;
  includePageTree: boolean;
  pageTreeScope: 'children' | 'drive';
  toolExposureMode: 'upfront' | 'search';
  machineAccess: boolean;
  machines: MachineRef[];
}

const PageAgentSettingsTab = forwardRef<PageAgentSettingsTabRef, PageAgentSettingsTabProps>(({
  pageId,
  driveId,
  config,
  onConfigUpdate,
  selectedProvider,
  selectedModel,
  onProviderChange,
  onModelChange,
  isProviderConfigured,
  onSavingChange
}, ref) => {
  const [isSaving, setIsSaving] = useState(false);
  const [membership, setMembership] = useState<AgentMembership | null | undefined>(undefined);
  const [membershipUserRole, setMembershipUserRole] = useState<'OWNER' | 'ADMIN' | 'MEMBER'>('MEMBER');
  const [driveRoles, setDriveRoles] = useState<DriveRole[]>([]);
  const [membershipSaving, setMembershipSaving] = useState(false);
  const [selectedMachineId, setSelectedMachineId] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function loadMembership() {
      try {
        const [membersRes, rolesRes] = await Promise.all([
          fetchWithAuth(`/api/drives/${driveId}/agents/members`),
          fetchWithAuth(`/api/drives/${driveId}/roles`),
        ]);
        if (cancelled) return;
        if (membersRes.ok) {
          const data = await membersRes.json();
          const entry = (data.agentMembers ?? []).find(
            (m: { agentPageId: string }) => m.agentPageId === pageId,
          );
          setMembership(entry ? { role: entry.role, customRole: entry.customRole } : null);
          setMembershipUserRole(data.currentUserRole ?? 'MEMBER');
        } else {
          setMembership(null);
        }
        if (rolesRes.ok) {
          const data = await rolesRes.json();
          setDriveRoles(data.roles ?? []);
        }
      } catch {
        if (!cancelled) setMembership(null);
      }
    }
    loadMembership();
    return () => { cancelled = true; };
  }, [pageId, driveId]);

  const handleMembershipRoleChange = useCallback(async (value: string) => {
    setMembershipSaving(true);
    try {
      const body: { role: 'MEMBER' | 'ADMIN'; customRoleId: string | null } =
        value === 'ADMIN'
          ? { role: 'ADMIN', customRoleId: null }
          : value === 'MEMBER'
          ? { role: 'MEMBER', customRoleId: null }
          : { role: 'MEMBER', customRoleId: value };
      await patch(`/api/drives/${driveId}/agents/${pageId}`, body);
      const customRole = body.customRoleId
        ? (driveRoles.find((r) => r.id === body.customRoleId) ?? null)
        : null;
      setMembership({
        role: body.role,
        customRole: customRole ? { id: customRole.id, name: customRole.name, color: customRole.color ?? null } : null,
      });
      toast.success('Role updated');
    } catch {
      toast.error('Failed to update role');
    } finally {
      setMembershipSaving(false);
    }
  }, [driveId, pageId, driveRoles]);

  // Dynamic Ollama models state
  const [ollamaModels, setOllamaModels] = useState<Record<string, string> | null>(null);

  // Dynamic LM Studio models state
  const [lmstudioModels, setLmstudioModels] = useState<Record<string, string> | null>(null);

  const { register, handleSubmit, setValue, reset, control, watch } = useForm<FormData>({
    defaultValues: {
      systemPrompt: config?.systemPrompt || '',
      enabledTools: config?.enabledTools || [],
      aiProvider: selectedProvider || '',
      aiModel: selectedModel || '',
      includeDrivePrompt: config?.includeDrivePrompt ?? false,
      agentDefinition: config?.agentDefinition || '',
      visibleToGlobalAssistant: config?.visibleToGlobalAssistant ?? true,
      includePageTree: config?.includePageTree ?? false,
      pageTreeScope: config?.pageTreeScope ?? 'children',
      toolExposureMode: config?.toolExposureMode ?? 'upfront',
      machineAccess: config?.machineAccess ?? false,
      machines: config?.machines ?? [],
    }
  });

  const { fields: machineFields, append: appendMachine, remove: removeMachine, move: moveMachine } = useFieldArray({
    control,
    name: 'machines',
  });

  // Reset form when config changes
  useEffect(() => {
    if (config) {
      reset({
        systemPrompt: config.systemPrompt,
        enabledTools: config.enabledTools,
        aiProvider: config.aiProvider || selectedProvider || '',
        aiModel: config.aiModel || selectedModel || '',
        includeDrivePrompt: config.includeDrivePrompt ?? false,
        agentDefinition: config.agentDefinition || '',
        visibleToGlobalAssistant: config.visibleToGlobalAssistant ?? true,
        includePageTree: config.includePageTree ?? false,
        pageTreeScope: config.pageTreeScope ?? 'children',
        toolExposureMode: config.toolExposureMode ?? 'upfront',
        machineAccess: config.machineAccess ?? false,
        machines: config.machines ?? [],
      });
    }
  }, [config, reset, selectedProvider, selectedModel]);

  // Fetch Ollama models dynamically
  const fetchOllamaModels = useCallback(async () => {
    // Return cached results if available
    if (ollamaModels) {
      return ollamaModels;
    }

    try {
      const response = await fetchWithAuth('/api/ai/ollama/models');
      const data = await response.json();

      if (data.success && data.models && Object.keys(data.models).length > 0) {
        setOllamaModels(data.models);
        return data.models;
      } else {
        // No fallback models - return empty object
        setOllamaModels({});
        return {};
      }
    } catch (error) {
      console.error('Failed to fetch Ollama models:', error);
      // No fallback models - return empty object
      setOllamaModels({});
      return {};
    }
  }, [ollamaModels]);

  // Fetch LM Studio models dynamically
  const fetchLMStudioModels = useCallback(async () => {
    // Return cached results if available
    if (lmstudioModels) {
      return lmstudioModels;
    }

    try {
      const response = await fetchWithAuth('/api/ai/lmstudio/models');
      const data = await response.json();

      if (data.success && data.models && Object.keys(data.models).length > 0) {
        setLmstudioModels(data.models);
        return data.models;
      } else {
        // No fallback models - return empty object
        setLmstudioModels({});
        return {};
      }
    } catch (error) {
      console.error('Failed to fetch LM Studio models:', error);
      // No fallback models - return empty object
      setLmstudioModels({});
      return {};
    }
  }, [lmstudioModels]);

  // Get models for the current provider (dynamic for Ollama and LM Studio, static for others)
  const getCurrentProviderModels = (): Record<string, string> => {
    if (selectedProvider === 'ollama' && ollamaModels) {
      return ollamaModels;
    }
    if (selectedProvider === 'lmstudio' && lmstudioModels) {
      return lmstudioModels;
    }
    return AI_PROVIDERS[selectedProvider as keyof typeof AI_PROVIDERS]?.models || {};
  };

  const onSubmit = useCallback(async (data: FormData) => {
    setIsSaving(true);
    onSavingChange?.(true);
    try {
      // Include the current provider and model from props
      const requestData = {
        ...data,
        aiProvider: selectedProvider,
        aiModel: selectedModel,
        includeDrivePrompt: data.includeDrivePrompt,
        agentDefinition: data.agentDefinition,
        visibleToGlobalAssistant: data.visibleToGlobalAssistant,
        includePageTree: data.includePageTree,
        pageTreeScope: data.pageTreeScope,
        machineAccess: data.machineAccess,
        machines: data.machines,
      };

      await patch(`/api/pages/${pageId}/agent-config`, requestData);

      const updatedConfig = {
        ...config,
        ...data,
        aiProvider: selectedProvider,
        aiModel: selectedModel,
        includeDrivePrompt: data.includeDrivePrompt,
        agentDefinition: data.agentDefinition,
        visibleToGlobalAssistant: data.visibleToGlobalAssistant,
        includePageTree: data.includePageTree,
        pageTreeScope: data.pageTreeScope,
        machineAccess: data.machineAccess,
        machines: data.machines,
      } as AgentConfig;
      onConfigUpdate(updatedConfig);
      toast.success('Agent configuration saved successfully');
    } catch (error) {
      console.error('Error saving agent configuration:', error);
      toast.error('Failed to save configuration');
    } finally {
      setIsSaving(false);
      onSavingChange?.(false);
    }
  }, [pageId, config, onConfigUpdate, selectedProvider, selectedModel, onSavingChange]);

  // Expose form submission to parent component
  useImperativeHandle(ref, () => ({
    submitForm: () => {
      handleSubmit(onSubmit)();
    },
    isSaving
  }), [handleSubmit, onSubmit, isSaving]);

  // Eagerly fetch models when provider is Ollama or LM Studio
  useEffect(() => {
    if (selectedProvider === 'ollama' && !ollamaModels) {
      fetchOllamaModels().catch(() => {
        console.debug('Initial Ollama model fetch failed');
      });
    }
    if (selectedProvider === 'lmstudio' && !lmstudioModels) {
      fetchLMStudioModels().catch(() => {
        console.debug('Initial LM Studio model fetch failed');
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProvider]); // Only selectedProvider - fetch functions are stable, models checked inline

  // Watch enabledTools for the count display
  const enabledTools = watch('enabledTools', []);
  const machineAccess = watch('machineAccess', false);

  const visibleTools = useMemo(
    () => (config?.availableTools || []).filter(
      (tool) => machineAccess || !MACHINE_TOOL_NAMES.has(tool.name)
    ),
    [config, machineAccess]
  );

  const handleSelectAllTools = () => {
    setValue('enabledTools', visibleTools.map(tool => tool.name));
  };

  const handleDeselectAllTools = () => {
    setValue('enabledTools', []);
  };

  const availableMachinesById = useMemo(
    () => new Map((config?.availableMachines || []).map((t) => [t.id, t])),
    [config]
  );
  const usedMachineIds = useMemo(
    () => new Set(machineFields.filter((m) => m.kind === 'existing').map((m) => m.machineId)),
    [machineFields]
  );
  const hasOwnMachine = machineFields.some((m) => m.kind === 'own');
  const machineOptions = (config?.availableMachines || []).filter((t) => !usedMachineIds.has(t.id));

  // Register with useEditingStore while dirty so SWR doesn't revalidate this
  // page mid-edit and clobber unsaved changes.
  const { isDirty: formIsDirty } = useFormState({ control });
  useEffect(() => {
    const componentId = `page-agent-settings-${pageId}`;
    if (formIsDirty) {
      useEditingStore.getState().startEditing(componentId, 'form', { pageId });
    } else {
      useEditingStore.getState().endEditing(componentId);
    }
    return () => { useEditingStore.getState().endEditing(componentId); };
  }, [formIsDirty, pageId]);

  if (!config) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex items-center space-x-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading agent configuration...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4">
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col space-y-6">
        {/* API Model ID */}
        <ApiModelIdCard pageId={pageId} />

        {/* AI Provider & Model Selection */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">AI Provider & Model</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Provider Selector */}
              <div>
                <label className="text-sm font-medium mb-2 block">AI Provider</label>
                <Select value={selectedProvider} onValueChange={onProviderChange}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(getVisibleProviders()).map(([key, provider]) => {
                      const configured = isProviderConfigured(key);
                      return (
                        <SelectItem key={key} value={key} disabled={!configured}>
                          <div className="flex items-center space-x-2">
                            <span>{provider.name}</span>
                            {!configured && <span className="text-xs text-muted-foreground">(Setup Required)</span>}
                          </div>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
              
              {/* Model Selector */}
              <div>
                <label className="text-sm font-medium mb-2 block">Model</label>
                <Select value={selectedModel} onValueChange={onModelChange}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>{AI_PROVIDERS[selectedProvider as keyof typeof AI_PROVIDERS]?.name} Models</SelectLabel>
                      {Object.entries(getCurrentProviderModels()).map(([key, name]) => (
                        <SelectItem key={key} value={key}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Choose the AI provider and specific model for this page&apos;s conversations.
            </p>
          </CardContent>
        </Card>

        {/* Drive Instructions Toggle - only show if drive has a prompt */}
        {config?.drivePrompt && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Bot className="h-5 w-5" />
                  <CardTitle className="text-lg">Include Drive Instructions</CardTitle>
                </div>
                <Controller
                  name="includeDrivePrompt"
                  control={control}
                  render={({ field }) => (
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  )}
                />
              </div>
              <CardDescription>
                When enabled, the drive&apos;s AI instructions will be prepended to this agent&apos;s system prompt.
              </CardDescription>
            </CardHeader>
            {watch('includeDrivePrompt') && (
              <CardContent>
                <div className="p-3 bg-muted/50 rounded-lg text-sm whitespace-pre-wrap max-h-48 overflow-y-auto">
                  {config.drivePrompt}
                </div>
              </CardContent>
            )}
          </Card>
        )}

        {/* System Prompt */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">System Prompt</CardTitle>
          </CardHeader>
          <CardContent>
            <label className="text-sm font-medium mb-2 block">Custom Instructions</label>
            <Textarea
              {...register('systemPrompt')}
              placeholder="Define your AI agent's behavior, personality, and instructions here..."
              className="min-h-[200px] resize-none w-full"
            />
            <p className="text-xs text-muted-foreground mt-2">
              Describe how you want your AI agent to behave, its role, expertise, and any specific instructions.
            </p>
          </CardContent>
        </Card>

        {/* Agent Definition & Global Assistant Visibility */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg">Global Assistant Awareness</CardTitle>
                <CardDescription>
                  Control how the global assistant discovers and interacts with this agent.
                </CardDescription>
              </div>
              <Controller
                name="visibleToGlobalAssistant"
                control={control}
                render={({ field }) => (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">Visible</span>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </div>
                )}
              />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Agent Definition</label>
              <Textarea
                {...register('agentDefinition', { maxLength: 500 })}
                placeholder="Describe what this agent does and when to consult it (e.g., 'Expert in financial analysis and budget planning. Consult for expense tracking, forecasting, and financial reports.')"
                className="min-h-[100px] resize-none"
                maxLength={500}
              />
              <div className="flex justify-between mt-2">
                <p className="text-xs text-muted-foreground">
                  This description helps the global assistant know when to use this agent.
                </p>
                <span className={`text-xs ${(watch('agentDefinition')?.length || 0) > 450 ? 'text-orange-500' : 'text-muted-foreground'}`}>
                  {watch('agentDefinition')?.length || 0}/500
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Workspace Structure Context */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FolderTree className="h-5 w-5" />
                <div>
                  <CardTitle className="text-lg">Workspace Structure</CardTitle>
                  <CardDescription>
                    Include page tree in the AI&apos;s context for navigation awareness.
                  </CardDescription>
                </div>
              </div>
              <Controller
                name="includePageTree"
                control={control}
                render={({ field }) => (
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                )}
              />
            </div>
          </CardHeader>
          {watch('includePageTree') && (
            <CardContent className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-2 block">Tree Scope</label>
                <Controller
                  name="pageTreeScope"
                  control={control}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="children">
                          <div className="flex flex-col">
                            <span>This page and children</span>
                            <span className="text-xs text-muted-foreground">Show subtree rooted at this page</span>
                          </div>
                        </SelectItem>
                        <SelectItem value="drive">
                          <div className="flex flex-col">
                            <span>Entire workspace</span>
                            <span className="text-xs text-muted-foreground">Show complete drive structure</span>
                          </div>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Large workspaces are automatically truncated to show complete depth levels up to 200 pages.
              </p>
            </CardContent>
          )}
        </Card>

        {/* Machine Access */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <TerminalSquare className="h-5 w-5" />
                <div>
                  <CardTitle className="text-lg">Machine Access</CardTitle>
                  <CardDescription>
                    Let this agent run commands on a persistent Machine and move between Machines.
                  </CardDescription>
                </div>
              </div>
              <Controller
                name="machineAccess"
                control={control}
                render={({ field }) => (
                  <Switch
                    checked={field.value}
                    onCheckedChange={(checked) => {
                      field.onChange(checked);
                      if (!checked) return;
                      if (machineFields.length === 0) appendMachine({ kind: 'own' });
                    }}
                  />
                )}
              />
            </div>
          </CardHeader>
          {machineAccess && (
            <CardContent className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-2 block">Machines</label>
                <p className="text-xs text-muted-foreground mb-3">
                  The agent moves between these with switch_machine. The first Machine is the default active one.
                </p>
                {machineFields.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No machines configured yet.</p>
                ) : (
                  <div className="space-y-2">
                    {machineFields.map((field, index) => {
                      const label = field.kind === 'own'
                        ? 'Own machine'
                        : availableMachinesById.get(field.machineId)?.title ?? 'Unknown machine';
                      return (
                        <div
                          key={field.id}
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
                              disabled={index === 0}
                              onClick={() => moveMachine(index, index - 1)}
                              aria-label="Move machine up"
                            >
                              <ArrowUp className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={index === machineFields.length - 1}
                              onClick={() => moveMachine(index, index + 1)}
                              aria-label="Move machine down"
                            >
                              <ArrowDown className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
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
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={hasOwnMachine}
                  onClick={() => appendMachine({ kind: 'own' })}
                >
                  Add own machine
                </Button>
                <Select value={selectedMachineId} onValueChange={setSelectedMachineId} disabled={machineOptions.length === 0}>
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
                <Button
                  type="button"
                  size="sm"
                  disabled={!selectedMachineId}
                  onClick={() => {
                    appendMachine({ kind: 'existing', machineId: selectedMachineId });
                    setSelectedMachineId('');
                  }}
                >
                  Add
                </Button>
              </div>
            </CardContent>
          )}
        </Card>

        {/* Drive Membership */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              <div>
                <CardTitle className="text-lg">Drive Membership</CardTitle>
                <CardDescription>
                  This agent&apos;s role within the drive determines which pages it can read and write.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {membership === undefined ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading…
              </div>
            ) : membership === null ? (
              <div className="flex items-center gap-2">
                <Badge variant="outline">Not a member</Badge>
                <span className="text-xs text-muted-foreground">
                  This agent has no explicit drive role. Add it via the Members page to grant access.
                </span>
              </div>
            ) : (membershipUserRole === 'OWNER' || membershipUserRole === 'ADMIN') ? (
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium">Role</span>
                <Select
                  value={
                    membership.role === 'ADMIN'
                      ? 'ADMIN'
                      : membership.customRole
                      ? membership.customRole.id
                      : 'MEMBER'
                  }
                  onValueChange={handleMembershipRoleChange}
                  disabled={membershipSaving}
                >
                  <SelectTrigger className="w-40 h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ADMIN">Admin</SelectItem>
                    <SelectItem value="MEMBER">Member</SelectItem>
                    {driveRoles.length > 0 && (
                      <>
                        <SelectSeparator />
                        {driveRoles.map((role) => (
                          <SelectItem key={role.id} value={role.id}>
                            {role.name}
                          </SelectItem>
                        ))}
                      </>
                    )}
                  </SelectContent>
                </Select>
                {membershipSaving && <Loader2 className="h-4 w-4 animate-spin" />}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                {membership.role === 'ADMIN' ? (
                  <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">Admin</Badge>
                ) : membership.customRole ? (
                  <Badge className={getRoleColorClasses(membership.customRole.color ?? undefined)}>
                    {membership.customRole.name}
                  </Badge>
                ) : (
                  <Badge className="bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300">Member</Badge>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Drives this agent can access */}
        <AgentDrivesCard agentPageId={pageId} />

        {/* Tool Permissions */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">Default Tools</CardTitle>
              <div className="flex space-x-2">
                <Button 
                  type="button"
                  variant="outline" 
                  size="sm" 
                  onClick={handleSelectAllTools}
                >
                  Select All
                </Button>
                <Button 
                  type="button"
                  variant="outline" 
                  size="sm" 
                  onClick={handleDeselectAllTools}
                >
                  Deselect All
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              The agent&apos;s default toolset. The Tools menu in the chat composer is the live control at runtime — it can enable or disable any tool per session.
            </p>
            <ScrollArea className="h-48">
              <Controller
                name="enabledTools"
                control={control}
                render={({ field: { value = [], onChange } }) => {
                  const toolRow = (tool: { name: string; description: string }) => (
                    <div key={tool.name} className="flex items-start space-x-3 p-2 rounded-lg hover:bg-muted/50">
                      <Checkbox
                        id={tool.name}
                        checked={value.includes(tool.name)}
                        onCheckedChange={(checked) => {
                          const newValue = checked
                            ? [...value, tool.name]
                            : value.filter(t => t !== tool.name);
                          onChange(newValue);
                        }}
                        className="mt-1"
                      />
                      <div className="flex-1">
                        <label
                          htmlFor={tool.name}
                          className="text-sm font-medium cursor-pointer"
                        >
                          {tool.name}
                        </label>
                        <p className="text-xs text-muted-foreground">
                          {tool.description}
                        </p>
                      </div>
                    </div>
                  );
                  const machineTools = visibleTools.filter((tool) => MACHINE_TOOL_NAMES.has(tool.name));
                  const otherTools = visibleTools.filter((tool) => !MACHINE_TOOL_NAMES.has(tool.name));
                  return (
                    <div className="space-y-3">
                      {machineTools.length > 0 && (
                        <>
                          <p className="text-xs font-semibold uppercase text-muted-foreground tracking-wide">Machine</p>
                          {machineTools.map(toolRow)}
                        </>
                      )}
                      {otherTools.map(toolRow)}
                    </div>
                  );
                }}
              />
            </ScrollArea>
            <p className="text-xs text-muted-foreground mt-2">
              Selected {enabledTools.length} of {visibleTools.length} tools
            </p>
          </CardContent>
        </Card>

        {/* Tool Exposure Mode */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Wrench className="h-5 w-5" />
              <div>
                <CardTitle className="text-lg">Tool Exposure</CardTitle>
                <CardDescription>
                  How this agent&apos;s tools are presented to the model.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <Controller
              name="toolExposureMode"
              control={control}
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="upfront">
                      <div className="flex flex-col">
                        <span>Upfront</span>
                        <span className="text-xs text-muted-foreground">Send every enabled tool schema to the model</span>
                      </div>
                    </SelectItem>
                    <SelectItem value="search">
                      <div className="flex flex-col">
                        <span>Search</span>
                        <span className="text-xs text-muted-foreground">Send core tools plus a search tool; the model discovers the rest on demand</span>
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
            <p className="text-xs text-muted-foreground">
              Search mode keeps the context small when many tools are enabled. The agent&apos;s tool selection above still applies — it can never reach a tool that isn&apos;t enabled.
            </p>
          </CardContent>
        </Card>

      </form>
    </div>
  );
});

PageAgentSettingsTab.displayName = 'PageAgentSettingsTab';

export default PageAgentSettingsTab;