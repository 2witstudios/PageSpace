import React, { useState, useEffect, useImperativeHandle, forwardRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useForm, Controller } from 'react-hook-form';

interface AgentConfig {
  systemPrompt: string;
  enabledTools: string[];
  availableTools: Array<{ name: string; description: string }>;
}

interface AgentSettingsTabProps {
  pageId: string;
  config: AgentConfig | null;
  onConfigUpdate: (config: AgentConfig) => void;
  selectedProvider: string;
  selectedModel: string;
  onProviderChange: (provider: string) => void;
  onModelChange: (model: string) => void;
  availableProviders: Record<string, { name: string; models: Record<string, string> }>;
  isProviderConfigured: (provider: string) => boolean;
}

export interface AgentSettingsTabRef {
  submitForm: () => void;
  isSaving: boolean;
}

interface FormData {
  systemPrompt: string;
  enabledTools: string[];
}

const AgentSettingsTab = forwardRef<AgentSettingsTabRef, AgentSettingsTabProps>(({ 
  pageId, 
  config, 
  onConfigUpdate, 
  selectedProvider, 
  selectedModel, 
  onProviderChange, 
  onModelChange, 
  availableProviders, 
  isProviderConfigured 
}, ref) => {
  const [isSaving, setIsSaving] = useState(false);

  const { register, handleSubmit, setValue, reset, control, watch } = useForm<FormData>({
    defaultValues: {
      systemPrompt: config?.systemPrompt || '',
      enabledTools: config?.enabledTools || [],
    }
  });

  // Reset form when config changes
  useEffect(() => {
    if (config) {
      reset({
        systemPrompt: config.systemPrompt,
        enabledTools: config.enabledTools,
      });
    }
  }, [config, reset]);

  const onSubmit = useCallback(async (data: FormData) => {
    setIsSaving(true);
    try {
      const response = await fetch(`/api/pages/${pageId}/agent-config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (response.ok) {
        const updatedConfig = { ...config, ...data } as AgentConfig;
        onConfigUpdate(updatedConfig);
        toast.success('Agent configuration saved successfully');
      } else {
        const error = await response.json();
        toast.error(error.error || 'Failed to save configuration');
      }
    } catch (error) {
      console.error('Error saving agent configuration:', error);
      toast.error('Failed to save configuration');
    } finally {
      setIsSaving(false);
    }
  }, [pageId, config, onConfigUpdate]);

  // Expose form submission to parent component
  useImperativeHandle(ref, () => ({
    submitForm: () => {
      handleSubmit(onSubmit)();
    },
    isSaving
  }), [handleSubmit, onSubmit, isSaving]);

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
                    {Object.entries(availableProviders).map(([key, provider]) => {
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
                      <SelectLabel>{availableProviders[selectedProvider]?.name} Models</SelectLabel>
                      {Object.entries(availableProviders[selectedProvider]?.models || {}).map(([key, name]) => (
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

AgentSettingsTab.displayName = 'AgentSettingsTab';

export default AgentSettingsTab;