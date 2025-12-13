import React, { useState, useEffect, useImperativeHandle, forwardRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Loader2, Bot, FolderTree } from 'lucide-react';
import { toast } from 'sonner';
import { useForm, Controller } from 'react-hook-form';
import { patch, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { AI_PROVIDERS } from '@/lib/ai/core';

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
}

interface PageAgentSettingsTabProps {
  pageId: string;
  config: AgentConfig | null;
  onConfigUpdate: (config: AgentConfig) => void;
  selectedProvider: string;
  selectedModel: string;
  onProviderChange: (provider: string) => void;
  onModelChange: (model: string) => void;
  isProviderConfigured: (provider: string) => boolean;
  onSavingChange?: (isSaving: boolean) => void;
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
}

const PageAgentSettingsTab = forwardRef<PageAgentSettingsTabRef, PageAgentSettingsTabProps>(({
  pageId,
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
    }
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

  const handleSelectAllTools = () => {
    const allToolNames = config?.availableTools.map(tool => tool.name) || [];
    setValue('enabledTools', allToolNames);
  };

  const handleDeselectAllTools = () => {
    setValue('enabledTools', []);
  };

  // Watch enabledTools for the count display
  const enabledTools = watch('enabledTools', []);

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
    <div className="h-full p-4">
      <form onSubmit={handleSubmit(onSubmit)} className="h-full flex flex-col space-y-6">
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
                    {Object.entries(AI_PROVIDERS).map(([key, provider]) => {
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
        <Card className="flex-1 flex flex-col">
          <CardHeader>
            <CardTitle className="text-lg">System Prompt</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col">
            <label className="text-sm font-medium mb-2 block">Custom Instructions</label>
            <Textarea
              {...register('systemPrompt')}
              placeholder="Define your AI agent's behavior, personality, and instructions here..."
              className="flex-1 min-h-[200px] resize-none"
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

        {/* Tool Permissions */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">Tool Permissions</CardTitle>
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
              Choose which tools your AI agent can access. This controls what actions the agent can perform.
            </p>
            <ScrollArea className="h-48">
              <Controller
                name="enabledTools"
                control={control}
                render={({ field: { value = [], onChange } }) => (
                  <div className="space-y-3">
                    {config.availableTools.map((tool) => (
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
                    ))}
                  </div>
                )}
              />
            </ScrollArea>
            <p className="text-xs text-muted-foreground mt-2">
              Selected {enabledTools.length} of {config.availableTools.length} tools
            </p>
          </CardContent>
        </Card>

      </form>
    </div>
  );
});

PageAgentSettingsTab.displayName = 'PageAgentSettingsTab';

export default PageAgentSettingsTab;