import React, { useState, useEffect, useImperativeHandle, forwardRef, useCallback, useMemo, useRef, useId } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Loader2, Bot, FolderTree, Shield, Copy, Check, Code2, Wrench, TerminalSquare } from 'lucide-react';
import { toast } from 'sonner';
import { useForm, useFormState, Controller } from 'react-hook-form';
import { patch, fetchWithAuth } from '@/lib/auth/auth-fetch';
import Link from 'next/link';
import { AI_PROVIDERS, getVisibleProviders } from '@/lib/ai/core/ai-providers-config';
import { getRoleColorClasses } from '@/lib/utils';
import { AgentDrivesCard } from './AgentDrivesCard';
import { SANDBOX_TOOL_NAMES } from '@/lib/ai/core/tool-filtering';
import { useEditingStore } from '@/stores/useEditingStore';

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
  sandboxEnabled?: boolean;
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
  sandboxEnabled: boolean;
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
  // Stable per-MOUNT identifier — distinguishes this instance from another
  // Settings surface for the SAME agent mounted elsewhere (see the
  // useEditingStore registration below, round 20).
  const mountId = useId();
  const [isSaving, setIsSaving] = useState(false);
  const [membership, setMembership] = useState<AgentMembership | null | undefined>(undefined);
  const [membershipUserRole, setMembershipUserRole] = useState<'OWNER' | 'ADMIN' | 'MEMBER'>('MEMBER');
  const [driveRoles, setDriveRoles] = useState<DriveRole[]>([]);
  const [membershipSaving, setMembershipSaving] = useState(false);

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
      sandboxEnabled: config?.sandboxEnabled ?? false,
    }
  });

  // Read early (moved up from its original spot near the useEditingStore
  // registration below) so the reset effect right below can gate on it.
  // `dirtyFields` additionally lets onSubmit tell "the user actually
  // edited this field in THIS instance" apart from "still whatever this
  // instance's own (possibly now-stale) form snapshot happens to hold" —
  // see onSubmit below, round 20.
  const { isDirty: formIsDirty, dirtyFields } = useFormState({ control });
  // Set right before THIS instance's own save propagates the new config
  // into the shared cache (onSubmit below) — distinguishes "my own save,
  // whose values I want as my new clean baseline" from "a SIBLING Settings
  // surface for the same agent just saved, and its update arrived here via
  // the shared SWR cache."
  const justSavedOwnConfigRef = useRef(false);
  // Set the first time THIS instance's own provider/model controls are
  // touched — distinguishes "the user explicitly picked this here" from
  // "still whatever useProviderSettings loaded on mount, possibly stale
  // relative to a sibling's later save" (see onSubmit below, round 18).
  const providerTouchedRef = useRef(false);
  const modelTouchedRef = useRef(false);

  // Reset form when config changes — but NOT when this surface has its own
  // unsaved edits from an EXTERNAL update (a different pane's Settings tab
  // for the SAME agent saving propagates through the shared config cache
  // `useAgentConfig` — see AgentPanes.tsx — and this effect used to reset
  // unconditionally, silently discarding whatever the user was mid-typing
  // here). Always resets for THIS instance's own save (justSavedOwnConfigRef)
  // — its own newly-saved values become the new clean baseline as before
  // (review finding — chatgpt-codex-connector on PR #2299, round 17).
  useEffect(() => {
    if (!config) return;
    if (formIsDirty && !justSavedOwnConfigRef.current) return;
    justSavedOwnConfigRef.current = false;
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
      sandboxEnabled: config.sandboxEnabled ?? false,
    });
  }, [config, reset, selectedProvider, selectedModel, formIsDirty]);

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
      // `selectedProvider`/`selectedModel` are OWNED by the parent's own
      // useProviderSettings() instance — a separate, per-mount hook with no
      // shared cache (unlike useAgentConfig). If this instance never
      // touched the provider/model controls itself, its copy can be stale
      // relative to a SIBLING Settings surface for the same agent that
      // just saved a provider change: submitting the stale prop here would
      // silently revert that sibling's save the moment this instance saves
      // anything else. Prefer the shared config's value in that case; only
      // this instance's OWN explicit selection overrides it (review
      // finding — chatgpt-codex-connector on PR #2299, round 18).
      //
      // Provider and model are a COUPLED pair — a model must belong to its
      // provider — so they are resolved from the SAME source together, not
      // independently: touching only the model here while a sibling
      // changed the provider must not combine this instance's (stale-
      // provider) model with the sibling's new provider, an invalid pair
      // the route rejects with a 400 (review finding — chatgpt-codex-
      // connector on PR #2299, round 20).
      const providerOrModelTouched = providerTouchedRef.current || modelTouchedRef.current;
      const resolvedProvider = providerOrModelTouched ? selectedProvider : (config?.aiProvider || selectedProvider);
      const resolvedModel = providerOrModelTouched ? selectedModel : (config?.aiModel || selectedModel);
      // Every OTHER field: send ONLY what THIS instance's form actually has
      // a pending edit for (react-hook-form's own dirtyFields) — a SPARSE
      // PATCH, omitting untouched fields entirely rather than merging in a
      // value copied from this instance's own (possibly already-stale)
      // config snapshot. The route already applies each field only `if
      // (field !== undefined)`, so an omitted field is left untouched
      // server-side. Round 20's "merge from local config" still raced: two
      // surfaces saving different fields close enough together that
      // neither's SWR update had reached the other yet would both submit
      // the SAME stale snapshot for their own "unedited" fields, and
      // whichever PATCH landed second would stomp the first's just-saved
      // change. Never sending a field this instance didn't touch removes
      // that race entirely (review finding — chatgpt-codex-connector on
      // PR #2299, round 21).
      const dirtyPatch: Partial<FormData> = {};
      if (dirtyFields.systemPrompt) dirtyPatch.systemPrompt = data.systemPrompt;
      if (dirtyFields.enabledTools) dirtyPatch.enabledTools = data.enabledTools;
      if (dirtyFields.includeDrivePrompt) dirtyPatch.includeDrivePrompt = data.includeDrivePrompt;
      if (dirtyFields.agentDefinition) dirtyPatch.agentDefinition = data.agentDefinition;
      if (dirtyFields.visibleToGlobalAssistant) dirtyPatch.visibleToGlobalAssistant = data.visibleToGlobalAssistant;
      if (dirtyFields.includePageTree) dirtyPatch.includePageTree = data.includePageTree;
      if (dirtyFields.pageTreeScope) dirtyPatch.pageTreeScope = data.pageTreeScope;
      if (dirtyFields.toolExposureMode) dirtyPatch.toolExposureMode = data.toolExposureMode;
      if (dirtyFields.sandboxEnabled) dirtyPatch.sandboxEnabled = data.sandboxEnabled;
      const requestData = {
        ...dirtyPatch,
        ...(providerOrModelTouched && { aiProvider: resolvedProvider, aiModel: resolvedModel }),
      };

      await patch(`/api/pages/${pageId}/agent-config`, requestData);

      // The LOCAL optimistic cache update is display-only (never sent to
      // the server above), so merging with the freshest config here is
      // safe — this just makes sure THIS instance's own edits are visible
      // immediately without waiting on a revalidation round trip.
      const updatedConfig = {
        ...config,
        ...dirtyPatch,
        ...(providerOrModelTouched && { aiProvider: resolvedProvider, aiModel: resolvedModel }),
      } as AgentConfig;
      // This save's own values should always become this instance's new
      // clean baseline, even though the form is (still, momentarily) dirty
      // when the reset effect runs — the dirty-guard above only exists to
      // protect against a DIFFERENT (sibling) surface's external update.
      justSavedOwnConfigRef.current = true;
      // Cleared here, not left true forever: `config.aiProvider`/`aiModel`
      // now correctly reflect what THIS instance just chose (onConfigUpdate
      // below), so "prefer the shared config" is exactly as correct for
      // this instance's own just-saved value as it is for reacting to a
      // LATER sibling's save. Leaving these true past this point would
      // permanently pin onSubmit to this instance's local snapshot and
      // revert every subsequent sibling save forever (review finding —
      // chatgpt-codex-connector on PR #2299, round 19).
      providerTouchedRef.current = false;
      modelTouchedRef.current = false;
      onConfigUpdate(updatedConfig);
      toast.success('Agent configuration saved successfully');
    } catch (error) {
      console.error('Error saving agent configuration:', error);
      toast.error('Failed to save configuration');
    } finally {
      setIsSaving(false);
      onSavingChange?.(false);
    }
  }, [pageId, config, onConfigUpdate, selectedProvider, selectedModel, onSavingChange, dirtyFields]);

  const handleProviderSelectChange = useCallback(
    (provider: string) => {
      providerTouchedRef.current = true;
      onProviderChange(provider);
    },
    [onProviderChange],
  );
  const handleModelSelectChange = useCallback(
    (model: string) => {
      modelTouchedRef.current = true;
      onModelChange(model);
    },
    [onModelChange],
  );

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

  // The sandbox switch gates the sandbox tool families out of the Default
  // Tools list (the old machineAccess/MACHINE_TOOL_NAMES behaviour). The
  // request-time filter in tool-filtering.ts is the real gate; this keeps the
  // picker from offering tools the agent will never receive.
  const sandboxEnabled = watch('sandboxEnabled', false);

  const visibleTools = useMemo(
    () =>
      (config?.availableTools || []).filter(
        (tool) => sandboxEnabled || !SANDBOX_TOOL_NAMES.has(tool.name)
      ),
    [config, sandboxEnabled]
  );

  // shouldDirty: true — without it, dirtyFields.enabledTools stays false
  // even though the displayed selection changed, so onSubmit's dirty-only
  // merge below would silently discard the bulk selection and resubmit
  // the stale config value instead (review finding — chatgpt-codex-
  // connector on PR #2299, round 21).
  const handleSelectAllTools = () => {
    setValue('enabledTools', visibleTools.map(tool => tool.name), { shouldDirty: true });
  };

  const handleDeselectAllTools = () => {
    setValue('enabledTools', [], { shouldDirty: true });
  };

  // Register with useEditingStore while dirty so SWR doesn't revalidate this
  // page mid-edit and clobber unsaved changes. (formIsDirty is declared
  // earlier, above the config-reset effect it also gates.) Keyed by a
  // per-MOUNT id (mountId, below), not just pageId: two Settings surfaces
  // for the SAME agent otherwise register the identical key, and either
  // one saving/unmounting deletes the shared Map entry out from under the
  // OTHER — a still-dirty sibling then silently drops out of
  // isAnyEditing(), letting SWR revalidation and other editing-paused
  // background work resume while it still has unsaved edits (review
  // finding — chatgpt-codex-connector on PR #2299, round 20).
  useEffect(() => {
    const componentId = `page-agent-settings-${pageId}-${mountId}`;
    if (formIsDirty) {
      useEditingStore.getState().startEditing(componentId, 'form', { pageId });
    } else {
      useEditingStore.getState().endEditing(componentId);
    }
    return () => { useEditingStore.getState().endEditing(componentId); };
  }, [formIsDirty, pageId, mountId]);

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
                <Select value={selectedProvider} onValueChange={handleProviderSelectChange}>
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
                <Select value={selectedModel} onValueChange={handleModelSelectChange}>
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

        {/* Sandbox — successor to the old Machine Access card, minus the
            machine topology: there is nothing to pick, because the sandbox
            belongs to the conversation's SESSION and is provisioned
            automatically the first time the agent needs it. */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <TerminalSquare className="h-5 w-5" />
                <div>
                  <CardTitle className="text-lg">Sandbox</CardTitle>
                  <CardDescription>
                    Let this agent run commands, edit files and use git in an isolated
                    sandbox. It&apos;s provisioned automatically the first time the agent
                    needs it — there is nothing to start or manage.
                  </CardDescription>
                </div>
              </div>
              <Controller
                name="sandboxEnabled"
                control={control}
                render={({ field }) => (
                  <Switch
                    aria-label="Sandbox access"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                )}
              />
            </div>
          </CardHeader>
        </Card>

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
                  return (
                    <div className="space-y-3">
                      {visibleTools.map(toolRow)}
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