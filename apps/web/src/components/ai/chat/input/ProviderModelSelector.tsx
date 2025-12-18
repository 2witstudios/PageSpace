'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ChevronDown, Check, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth, patch } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';
import {
  AI_PROVIDERS,
  getModelDisplayName,
  getDefaultModel,
} from '@/lib/ai/core/ai-providers-config';

interface ProviderStatus {
  isConfigured: boolean;
  hasApiKey?: boolean;
  hasBaseUrl?: boolean;
}

interface ProviderSettings {
  currentProvider: string;
  currentModel: string;
  providers: Record<string, ProviderStatus>;
  isAnyProviderConfigured: boolean;
}

/** Category mapping for providers */
const PROVIDER_CATEGORIES: Record<string, 'default' | 'cloud' | 'local'> = {
  pagespace: 'default',
  ollama: 'local',
  lmstudio: 'local',
  // All others default to 'cloud'
};

/** Derive provider groups from AI_PROVIDERS configuration */
const PROVIDER_GROUPS = (() => {
  const groups: { label: string; providers: { id: string; name: string }[] }[] = [
    { label: 'Default', providers: [] },
    { label: 'Cloud Providers', providers: [] },
    { label: 'Local', providers: [] },
  ];

  for (const [id, config] of Object.entries(AI_PROVIDERS)) {
    const category = PROVIDER_CATEGORIES[id] || 'cloud';
    const provider = { id, name: config.name };

    if (category === 'default') {
      groups[0].providers.push(provider);
    } else if (category === 'local') {
      groups[2].providers.push(provider);
    } else {
      groups[1].providers.push(provider);
    }
  }

  return groups;
})();

export interface ProviderModelSelectorProps {
  /** Currently selected provider */
  provider?: string | null;
  /** Currently selected model */
  model?: string | null;
  /** Callback when provider/model changes */
  onChange?: (provider: string, model: string) => void;
  /** Additional class names */
  className?: string;
  /** Disable the selector */
  disabled?: boolean;
}

/**
 * Two separate popover selectors for AI provider and model selection.
 * Used in the InputFooter for quick model switching.
 */
export function ProviderModelSelector({
  provider,
  model,
  onChange,
  className,
  disabled = false,
}: ProviderModelSelectorProps) {
  const [providerOpen, setProviderOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [providerSettings, setProviderSettings] =
    useState<ProviderSettings | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Fetch provider settings on mount
  useEffect(() => {
    const fetchSettings = async () => {
      setIsLoading(true);
      try {
        const response = await fetchWithAuth('/api/ai/settings');
        if (response.ok) {
          const data = await response.json();
          setProviderSettings(data);
        }
      } catch (error) {
        console.error('Failed to fetch provider settings:', error);
        toast.error('Failed to load AI provider settings');
      } finally {
        setIsLoading(false);
      }
    };

    fetchSettings();
  }, []);

  // Get display names
  const providerDisplayName = useMemo(() => {
    if (!provider) return 'PageSpace';
    const config = AI_PROVIDERS[provider as keyof typeof AI_PROVIDERS];
    return config?.name || provider;
  }, [provider]);

  const modelDisplayName = useMemo(() => {
    if (!model || !provider) return 'Standard';
    return getModelDisplayName(provider, model);
  }, [provider, model]);

  // Check if a provider is configured
  const isProviderConfigured = useCallback(
    (providerId: string) => {
      if (!providerSettings) return false;
      const status = providerSettings.providers[providerId];
      if (!status) {
        // pagespace is always configured
        if (providerId === 'pagespace') return true;
        return false;
      }
      return status.isConfigured;
    },
    [providerSettings]
  );

  // Get models for current provider
  const availableModels = useMemo(() => {
    if (!provider) return [];
    const config = AI_PROVIDERS[provider as keyof typeof AI_PROVIDERS];
    if (!config) return [];
    return Object.entries(config.models);
  }, [provider]);

  // Handle provider selection
  const handleProviderSelect = useCallback(
    async (newProvider: string) => {
      if (newProvider === provider) {
        setProviderOpen(false);
        return;
      }

      setIsSaving(true);
      try {
        const newModel = getDefaultModel(newProvider);

        await patch('/api/ai/settings', {
          provider: newProvider,
          model: newModel,
        });

        onChange?.(newProvider, newModel);
        setProviderOpen(false);
      } catch (error) {
        console.error('Failed to update provider:', error);
        toast.error('Failed to update provider');
      } finally {
        setIsSaving(false);
      }
    },
    [provider, onChange]
  );

  // Handle model selection
  const handleModelSelect = useCallback(
    async (newModel: string) => {
      if (newModel === model || !provider) {
        setModelOpen(false);
        return;
      }

      setIsSaving(true);
      try {
        await patch('/api/ai/settings', {
          provider,
          model: newModel,
        });

        onChange?.(provider, newModel);
        setModelOpen(false);
      } catch (error) {
        console.error('Failed to update model:', error);
        toast.error('Failed to update model');
      } finally {
        setIsSaving(false);
      }
    },
    [provider, model, onChange]
  );

  if (isLoading) {
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled
        className="h-8 px-2 gap-1 text-muted-foreground"
      >
        <Loader2 className="h-3 w-3 animate-spin" />
      </Button>
    );
  }

  return (
    <div className={cn('flex items-center gap-0.5', className)}>
      {/* Provider Selector */}
      <Popover open={providerOpen} onOpenChange={setProviderOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || isSaving}
            className="h-8 px-2 gap-1 text-muted-foreground hover:text-foreground hover:bg-transparent dark:hover:bg-transparent"
          >
            <span className="text-xs">{providerDisplayName}</span>
            <ChevronDown className="h-3 w-3 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-52 p-0" align="end" sideOffset={8}>
          <ScrollArea className="h-[280px] p-2">
            <div className="space-y-2">
              {PROVIDER_GROUPS.map((group) => (
                <div key={group.label}>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-1 px-2">
                    {group.label}
                  </div>
                  <div className="space-y-0.5">
                    {group.providers.map((p) => {
                      const configured = isProviderConfigured(p.id);
                      const isSelected = provider === p.id;
                      return (
                        <Button
                          key={p.id}
                          variant={isSelected ? 'secondary' : 'ghost'}
                          size="sm"
                          disabled={!configured || isSaving}
                          onClick={() => handleProviderSelect(p.id)}
                          className={cn(
                            'w-full justify-between text-xs h-7 px-2 min-w-0',
                            !configured && 'opacity-50'
                          )}
                        >
                          <span className="truncate min-w-0">{p.name}</span>
                          {isSelected && <Check className="h-3 w-3 shrink-0 ml-1" />}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </PopoverContent>
      </Popover>

      <span className="text-muted-foreground/30 text-xs">/</span>

      {/* Model Selector */}
      <Popover open={modelOpen} onOpenChange={setModelOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || isSaving}
            className="h-8 px-2 gap-1 text-muted-foreground hover:text-foreground hover:bg-transparent dark:hover:bg-transparent"
          >
            <span className="text-xs max-w-[100px] truncate">
              {modelDisplayName}
            </span>
            <ChevronDown className="h-3 w-3 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-52 p-0" align="end" sideOffset={8}>
          <ScrollArea className="h-[200px] p-2">
            <div className="space-y-0.5">
              {availableModels.length === 0 ? (
                <div className="text-xs text-muted-foreground px-2 py-2">
                  {provider === 'ollama' || provider === 'lmstudio'
                    ? 'No models found. Start your local server.'
                    : 'No models available'}
                </div>
              ) : (
                availableModels.map(([modelId, modelName]) => {
                  const isSelected = model === modelId;
                  return (
                    <Button
                      key={modelId}
                      variant={isSelected ? 'secondary' : 'ghost'}
                      size="sm"
                      disabled={isSaving}
                      onClick={() => handleModelSelect(modelId)}
                      className="w-full justify-between text-xs h-7 px-2 min-w-0"
                    >
                      <span className="truncate min-w-0">{modelName}</span>
                      {isSelected && <Check className="h-3 w-3 shrink-0 ml-1" />}
                    </Button>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export default ProviderModelSelector;
