import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { CheckCircle, XCircle, Zap, Bot, Wrench, FolderTree } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import {
  AI_PROVIDERS,
  getVisibleProviders,
  getDefaultModel,
  getUserFacingModelName,
  isModelAllowedForTier,
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
} from '@/lib/ai/core/ai-providers-config';
import { patch, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useAssistantSettingsStore } from '@/stores/useAssistantSettingsStore';
import { useBillingVisibility } from '@/hooks/useBillingVisibility';
import type { AgentInfo } from '@/types/agent';

interface ProviderAvailability {
  isAvailable: boolean;
}

interface ProviderSettings {
  currentProvider: string;
  currentModel: string;
  providers: Partial<Record<string, ProviderAvailability>>;
  isAnyProviderConfigured: boolean;
  userSubscriptionTier?: string;
}

interface SaveSettingsResult {
  message: string;
  success?: boolean;
}

interface SidebarSettingsTabProps {
  selectedAgent: AgentInfo | null;
}

const isLocalProvider = (provider: string) =>
  provider === 'ollama' || provider === 'lmstudio' || provider === 'azure_openai';

/**
 * Assistant settings tab for the right sidebar.
 *
 * Shows Global Assistant settings when no agent is selected.
 * When an agent is selected, shows info message directing to agent page.
 */
const SidebarSettingsTab: React.FC<SidebarSettingsTabProps> = ({
  selectedAgent,
}) => {
  const router = useRouter();
  const [providerSettings, setProviderSettings] = useState<ProviderSettings | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string>(DEFAULT_PROVIDER);
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Dynamic Ollama models state
  const [ollamaModels, setOllamaModels] = useState<Record<string, string> | null>(null);
  const [ollamaModelsLoading, setOllamaModelsLoading] = useState(false);
  const [ollamaModelsError, setOllamaModelsError] = useState<string | null>(null);

  // Dynamic LM Studio models state
  const [lmstudioModels, setLmstudioModels] = useState<Record<string, string> | null>(null);

  // Billing visibility (hide upgrade CTA on iOS)
  const { showBilling } = useBillingVisibility();

  // Page tree context toggle (from centralized store)
  const showPageTree = useAssistantSettingsStore((state) => state.showPageTree);
  const setShowPageTree = useAssistantSettingsStore((state) => state.setShowPageTree);

  const subscriptionTier = providerSettings?.userSubscriptionTier;

  // Fetch Ollama models dynamically
  const fetchOllamaModels = useCallback(async () => {
    if (ollamaModels) return ollamaModels;

    setOllamaModelsLoading(true);
    setOllamaModelsError(null);

    try {
      const response = await fetchWithAuth('/api/ai/ollama/models');
      const data = await response.json();

      if (data.success && data.models && Object.keys(data.models).length > 0) {
        setOllamaModels(data.models);
        return data.models;
      } else {
        setOllamaModels({});
        setOllamaModelsError(data.error || 'No models available');
        return {};
      }
    } catch (error) {
      console.error('Failed to fetch Ollama models:', error);
      setOllamaModels({});
      setOllamaModelsError('Connection failed');
      return {};
    } finally {
      setOllamaModelsLoading(false);
    }
  }, [ollamaModels]);

  // Fetch LM Studio models dynamically
  const fetchLMStudioModels = useCallback(async () => {
    if (lmstudioModels) return lmstudioModels;

    try {
      const response = await fetchWithAuth('/api/ai/lmstudio/models');
      const data = await response.json();

      if (data.success && data.models && Object.keys(data.models).length > 0) {
        setLmstudioModels(data.models);
        return data.models;
      } else {
        setLmstudioModels({});
        return {};
      }
    } catch (error) {
      console.error('Failed to fetch LM Studio models:', error);
      setLmstudioModels({});
      return {};
    }
  }, [lmstudioModels]);

  // Load current settings
  const loadSettings = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/api/ai/settings');
      if (response.ok) {
        const data: ProviderSettings = await response.json();
        setProviderSettings(data);
        setSelectedProvider(data.currentProvider);
        setSelectedModel(data.currentModel);

        // If the saved model isn't accessible to this tier, reset to the default.
        if (!isLocalProvider(data.currentProvider) &&
            !isModelAllowedForTier(data.currentModel, data.userSubscriptionTier)) {
          setSelectedProvider(DEFAULT_PROVIDER);
          setSelectedModel(DEFAULT_MODEL);
        }

        if (data.currentProvider === 'ollama') {
          try { await fetchOllamaModels(); } catch { /* handled in fetcher */ }
        }
        if (data.currentProvider === 'lmstudio') {
          try { await fetchLMStudioModels(); } catch { /* handled in fetcher */ }
        }
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
    } finally {
      setLoading(false);
    }
  }, [fetchOllamaModels, fetchLMStudioModels]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // Listen for settings updates from other components
  useEffect(() => {
    const handleSettingsUpdate = () => {
      loadSettings();
    };

    window.addEventListener('ai-settings-updated', handleSettingsUpdate);
    return () => {
      window.removeEventListener('ai-settings-updated', handleSettingsUpdate);
    };
  }, [loadSettings]);

  const handleProviderChange = async (provider: string) => {
    setSelectedProvider(provider);

    // Local providers bypass currentModelLocked, so Save stays enabled after switching.
    // If discovery yields no models (empty or error), clear the stale cloud model id so
    // we never PATCH a local provider with a mismatched model.
    if (provider === 'ollama') {
      try {
        const models = await fetchOllamaModels();
        if (Object.keys(models).length > 0) {
          setSelectedModel(Object.keys(models)[0]);
        } else {
          setSelectedModel('');
          toast.error('No models available in Ollama. Ensure the server is running and models are downloaded.');
        }
      } catch {
        setSelectedModel('');
        toast.error('Failed to connect to Ollama. Ensure the server is running.');
      }
    } else if (provider === 'lmstudio') {
      try {
        const models = await fetchLMStudioModels();
        if (Object.keys(models).length > 0) {
          setSelectedModel(Object.keys(models)[0]);
        } else {
          setSelectedModel('');
          toast.error('No models available in LM Studio. Ensure the server is running and models are loaded.');
        }
      } catch {
        setSelectedModel('');
        toast.error('Failed to connect to LM Studio. Ensure the server is running.');
      }
    } else {
      setSelectedModel(getDefaultModel(provider));
    }
  };

  const handleModelChange = (model: string) => {
    setSelectedModel(model);
  };

  // Models for the current provider (dynamic for Ollama/LM Studio, static otherwise)
  const getCurrentProviderModels = (): Record<string, string> => {
    if (selectedProvider === 'ollama' && ollamaModels) return ollamaModels;
    if (selectedProvider === 'lmstudio' && lmstudioModels) return lmstudioModels;
    return AI_PROVIDERS[selectedProvider as keyof typeof AI_PROVIDERS]?.models || {};
  };

  // Whether the current tier may select this model.
  const hasModelAccess = (provider: string, model: string): boolean => {
    if (isLocalProvider(provider)) return true;
    return isModelAllowedForTier(model, subscriptionTier);
  };

  const isProviderConfigured = (provider: string): boolean => {
    return providerSettings?.providers?.[provider]?.isAvailable ?? false;
  };

  // Providers visible in this deployment that are actually configured.
  const availableProviders = Object.entries(getVisibleProviders()).filter(([key]) =>
    isProviderConfigured(key)
  );

  // Get setProviderSettings from the centralized store
  const setStoreProviderSettings = useAssistantSettingsStore((state) => state.setProviderSettings);

  const handleSaveSettings = async () => {
    setSaving(true);
    try {
      const result = await patch<SaveSettingsResult>('/api/ai/settings', {
        provider: selectedProvider,
        model: selectedModel,
      });

      if (providerSettings) {
        setProviderSettings({
          ...providerSettings,
          currentProvider: selectedProvider,
          currentModel: selectedModel,
        });
      }

      setStoreProviderSettings(selectedProvider, selectedModel);
      toast.success(result.message || 'Settings saved successfully!');
    } catch (error) {
      console.error('Failed to save settings:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to save settings. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  // Agent mode: Show info message instead of global settings
  if (selectedAgent) {
    return (
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="p-3 border-b">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-medium truncate">{selectedAgent.title} Settings</h3>
          </div>
        </div>

        {/* Agent Info Content */}
        <div className="flex-grow overflow-y-auto">
          <div className="p-4 space-y-4">
            <Card>
              <CardContent className="pt-6">
                <div className="text-center space-y-4">
                  <div className="h-12 w-12 mx-auto rounded-full bg-primary/10 flex items-center justify-center">
                    <Bot className="h-6 w-6 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{selectedAgent.title}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Agent settings are configured in the agent page.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Agent Configuration Info */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Configuration</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">AI Model</span>
                  <Badge variant="secondary">
                    {getUserFacingModelName(selectedAgent.aiProvider, selectedAgent.aiModel)}
                  </Badge>
                </div>
                {selectedAgent.enabledTools && selectedAgent.enabledTools.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Wrench className="h-3 w-3" />
                      <span>Enabled Tools ({selectedAgent.enabledTools.length})</span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {selectedAgent.enabledTools.slice(0, 5).map((tool) => (
                        <Badge key={tool} variant="outline" className="text-xs">
                          {tool}
                        </Badge>
                      ))}
                      {selectedAgent.enabledTools.length > 5 && (
                        <Badge variant="outline" className="text-xs">
                          +{selectedAgent.enabledTools.length - 5} more
                        </Badge>
                      )}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t p-3">
          <div className="text-xs text-muted-foreground text-center">
            From {selectedAgent.driveName}
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="p-3 border-b">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-4 rounded" />
            <Skeleton className="h-4 w-28" />
          </div>
        </div>
        <div className="flex-grow p-4 space-y-4">
          <div className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-10 w-full" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-10 w-full" />
          </div>
        </div>
      </div>
    );
  }

  const currentModelLocked = !hasModelAccess(selectedProvider, selectedModel);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-3 border-b">
        <h3 className="text-sm font-medium">Global Settings</h3>
      </div>

      {/* Settings Content - with native scrolling */}
      <div className="flex-grow overflow-y-auto">
        <div className="p-4 space-y-4">

          {/* Provider Selection */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Active Model</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <label className="text-xs font-medium">Provider</label>
                <Select value={selectedProvider} onValueChange={handleProviderChange}>
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {availableProviders.map(([key, provider]) => (
                      <SelectItem key={key} value={key}>
                        <div className="flex items-center space-x-2">
                          <span>{provider.name}</span>
                          <CheckCircle className="h-3 w-3 text-green-500" />
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium">
                  Model
                  {selectedProvider === 'ollama' && ollamaModelsLoading && (
                    <span className="ml-1 text-xs text-muted-foreground">(Loading...)</span>
                  )}
                  {selectedProvider === 'ollama' && ollamaModelsError && (
                    <span className="ml-1 text-xs text-orange-600">({ollamaModelsError})</span>
                  )}
                </label>
                <Select value={selectedModel} onValueChange={handleModelChange}>
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(getCurrentProviderModels()).map(([key, name]) => {
                      const hasAccess = hasModelAccess(selectedProvider, key);
                      return (
                        <SelectItem key={key} value={key} disabled={!hasAccess}>
                          <div className="flex items-center justify-between w-full">
                            <span className={!hasAccess ? 'text-muted-foreground' : ''}>{name as string}</span>
                            {!hasAccess && (
                              <Badge variant="outline" className="text-xs ml-2">
                                Paid
                              </Badge>
                            )}
                          </div>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>

              <Button
                onClick={handleSaveSettings}
                disabled={saving || currentModelLocked}
                className="w-full h-8 text-xs"
              >
                {saving ? 'Saving...' : 'Save Settings'}
              </Button>
            </CardContent>
          </Card>

          {/* Workspace Structure Toggle */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FolderTree className="h-4 w-4" />
                  <CardTitle className="text-sm">Workspace Structure</CardTitle>
                </div>
                <Switch
                  checked={showPageTree}
                  onCheckedChange={setShowPageTree}
                />
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <p className="text-xs text-muted-foreground">
                When enabled, the assistant can see your workspace page tree for better navigation awareness.
              </p>
            </CardContent>
          </Card>

          {/* Upgrade notification for restricted models (hidden on iOS) */}
          {showBilling && subscriptionTier === 'free' && currentModelLocked && (
            <Card className="border-primary/20 bg-primary/5 dark:bg-primary/10">
              <CardContent className="pt-6">
                <div className="text-center space-y-3">
                  <div className="h-8 w-8 mx-auto rounded-full bg-primary/10 dark:bg-primary/20 flex items-center justify-center">
                    <Zap className="h-4 w-4 text-primary dark:text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-primary dark:text-foreground">
                      Unlock every model
                    </p>
                    <p className="text-xs text-primary/80 dark:text-primary mt-1">
                      Upgrade to a paid plan for access to the full model catalog.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => router.push('/settings/usage')}
                    className="w-full border-primary/30 text-primary hover:bg-primary/10 dark:border-primary/30 dark:text-primary dark:hover:bg-primary/20"
                  >
                    View Upgrade Options
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* No provider configured */}
          {!providerSettings?.isAnyProviderConfigured && (
            <Card className="border-orange-200 bg-orange-50 dark:bg-orange-950/20">
              <CardContent className="pt-6">
                <div className="text-center space-y-3">
                  <XCircle className="h-8 w-8 mx-auto text-orange-600 dark:text-orange-400" />
                  <p className="text-sm text-orange-800 dark:text-orange-200">
                    AI is not configured on this deployment.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Footer - for consistent structure */}
      <div className="border-t p-3">
        <div className="text-xs text-muted-foreground text-center">
          {providerSettings?.isAnyProviderConfigured
            ? '✓ AI Provider Configured'
            : 'AI provider not configured'}
        </div>
      </div>
    </div>
  );
};

export default SidebarSettingsTab;
