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
 * Compact popover selector for AI provider and model selection.
 * Used in the InputFooter for quick model switching.
 */
export function ProviderModelSelector({
  provider,
  model,
  onChange,
  className,
  disabled = false,
}: ProviderModelSelectorProps) {
  const [open, setOpen] = useState(false);
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
      if (newProvider === provider) return;

      setIsSaving(true);
      try {
        const newModel = getDefaultModel(newProvider);

        // Update user settings via API - patch returns parsed JSON, throws on error
        await patch('/api/ai/settings', {
          provider: newProvider,
          model: newModel,
        });

        onChange?.(newProvider, newModel);
      } catch (error) {
        console.error('Failed to update provider:', error);
      } finally {
        setIsSaving(false);
      }
    },
    [provider, onChange]
  );

  // Handle model selection
  const handleModelSelect = useCallback(
    async (newModel: string) => {
      if (newModel === model || !provider) return;

      setIsSaving(true);
      try {
        // Update user settings via API - patch returns parsed JSON, throws on error
        await patch('/api/ai/settings', {
          provider,
          model: newModel,
        });

        onChange?.(provider, newModel);
        setOpen(false);
      } catch (error) {
        console.error('Failed to update model:', error);
      } finally {
        setIsSaving(false);
      }
    },
    [provider, model, onChange]
  );

  // Provider groups for organized display
  const providerGroups = useMemo(() => {
    return [
      {
        label: 'Default',
        providers: [{ id: 'pagespace', name: 'PageSpace' }],
      },
      {
        label: 'Cloud Providers',
        providers: [
          { id: 'openrouter', name: 'OpenRouter' },
          { id: 'openrouter_free', name: 'OpenRouter (Free)' },
          { id: 'google', name: 'Google AI' },
          { id: 'openai', name: 'OpenAI' },
          { id: 'anthropic', name: 'Anthropic' },
          { id: 'xai', name: 'xAI (Grok)' },
          { id: 'glm', name: 'GLM' },
        ],
      },
      {
        label: 'Local',
        providers: [
          { id: 'ollama', name: 'Ollama' },
          { id: 'lmstudio', name: 'LM Studio' },
        ],
      },
    ];
  }, []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || isLoading}
          className={cn(
            'h-8 px-2 gap-1 text-muted-foreground hover:text-foreground hover:bg-transparent dark:hover:bg-transparent',
            className
          )}
        >
          {isLoading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <>
              <span className="text-xs">{providerDisplayName}</span>
              <span className="text-muted-foreground/50">/</span>
              <span className="text-xs max-w-[80px] truncate">
                {modelDisplayName}
              </span>
              <ChevronDown className="h-3 w-3 shrink-0" />
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="end" sideOffset={8}>
        <div className="flex flex-col">
          {/* Provider Section */}
          <div className="p-3 border-b">
            <div className="text-xs font-medium text-muted-foreground mb-2">
              Provider
            </div>
            <ScrollArea className="max-h-[180px]">
              <div className="space-y-2">
                {providerGroups.map((group) => (
                  <div key={group.label}>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-1 px-1">
                      {group.label}
                    </div>
                    <div className="grid grid-cols-2 gap-1">
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
                              'justify-start text-xs h-7 px-2',
                              !configured && 'opacity-50'
                            )}
                          >
                            <span className="truncate flex-1 text-left">
                              {p.name}
                            </span>
                            {isSelected && (
                              <Check className="h-3 w-3 shrink-0 ml-1" />
                            )}
                          </Button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>

          {/* Model Section */}
          <div className="p-3">
            <div className="text-xs font-medium text-muted-foreground mb-2">
              Model
            </div>
            <ScrollArea className="max-h-[200px]">
              <div className="space-y-0.5">
                {availableModels.length === 0 ? (
                  <div className="text-xs text-muted-foreground px-2 py-2">
                    {provider === 'ollama' || provider === 'lmstudio'
                      ? 'Models discovered from local server'
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
                        className="w-full justify-start text-xs h-7 px-2"
                      >
                        <span className="truncate flex-1 text-left">
                          {modelName}
                        </span>
                        {isSelected && (
                          <Check className="h-3 w-3 shrink-0 ml-1" />
                        )}
                      </Button>
                    );
                  })
                )}
              </div>
            </ScrollArea>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default ProviderModelSelector;
