import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { CheckCircle, XCircle, Key, ExternalLink, Zap, Bot, Wrench, FolderTree } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { AI_PROVIDERS, getBackendProvider } from '@/lib/ai/core/ai-providers-config';
import { patch, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useAssistantSettingsStore } from '@/stores/useAssistantSettingsStore';
import type { AgentInfo } from '@/types/agent';

// Using centralized AI providers configuration from ai-providers-config.ts

interface ProviderSettings {
  currentProvider: string;
  currentModel: string;
  providers: {
    pagespace?: { isConfigured: boolean; hasApiKey: boolean };
    openrouter: { isConfigured: boolean; hasApiKey: boolean };
    google: { isConfigured: boolean; hasApiKey: boolean };
    openai: { isConfigured: boolean; hasApiKey: boolean };
    anthropic: { isConfigured: boolean; hasApiKey: boolean };
    xai: { isConfigured: boolean; hasApiKey: boolean };
    ollama: { isConfigured: boolean; hasBaseUrl: boolean };
    lmstudio: { isConfigured: boolean; hasBaseUrl: boolean };
    glm: { isConfigured: boolean; hasApiKey: boolean };
    minimax: { isConfigured: boolean; hasApiKey: boolean };
  };
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
  const [selectedProvider, setSelectedProvider] = useState<string>('pagespace');
  const [selectedModel, setSelectedModel] = useState<string>('glm-4.5-air');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Dynamic Ollama models state
  const [ollamaModels, setOllamaModels] = useState<Record<string, string> | null>(null);
  const [ollamaModelsLoading, setOllamaModelsLoading] = useState(false);
  const [ollamaModelsError, setOllamaModelsError] = useState<string | null>(null);

  // Dynamic LM Studio models state
  const [lmstudioModels, setLmstudioModels] = useState<Record<string, string> | null>(null);

  // Page tree context toggle (from centralized store)
  const showPageTree = useAssistantSettingsStore((state) => state.showPageTree);
  const setShowPageTree = useAssistantSettingsStore((state) => state.setShowPageTree);

  // Fetch Ollama models dynamically
  const fetchOllamaModels = useCallback(async () => {
    // Return cached results if available
    if (ollamaModels) {
      return ollamaModels;
    }

    setOllamaModelsLoading(true);
    setOllamaModelsError(null);

    try {
      const response = await fetchWithAuth('/api/ai/ollama/models');
      const data = await response.json();

      if (data.success && data.models && Object.keys(data.models).length > 0) {
        setOllamaModels(data.models);
        return data.models;
      } else {
        // No fallback models - return empty object
        setOllamaModels({});
        setOllamaModelsError(data.error || 'No models available');
        return {};
      }
    } catch (error) {
      console.error('Failed to fetch Ollama models:', error);
      // No fallback models - return empty object
      setOllamaModels({});
      setOllamaModelsError('Connection failed');
      return {};
    } finally {
      setOllamaModelsLoading(false);
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

  // Load current settings
  const loadSettings = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/api/ai/settings');
      if (response.ok) {
        const data: ProviderSettings = await response.json();
        setProviderSettings(data);

        // Determine the correct UI provider based on the model
        let uiProvider = data.currentProvider;
        if (data.currentProvider === 'openrouter' && data.currentModel) {
          // Check if the model is a free model (ends with :free)
          if (data.currentModel.endsWith(':free')) {
            uiProvider = 'openrouter_free';
          }
        }

        setSelectedProvider(uiProvider);
        setSelectedModel(data.currentModel);

        // Check if current model is accessible to user, if not, reset to default
        if (uiProvider === 'pagespace' && data.currentModel === 'glm-4.7') {
          const userTier = data.userSubscriptionTier;
          if (userTier !== 'pro' && userTier !== 'business') {
            // Free user has restricted model selected, reset to default
            setSelectedModel('glm-4.5-air');
          }
        }

        // If current provider is Ollama or LM Studio, eagerly fetch models to avoid empty dropdown
        if (uiProvider === 'ollama') {
          try {
            await fetchOllamaModels();
          } catch {
            // Silently handle errors - fetchOllamaModels already has error handling
            console.debug('Initial Ollama model fetch failed, will use fallback models');
          }
        }
        if (uiProvider === 'lmstudio') {
          try {
            await fetchLMStudioModels();
          } catch {
            // Silently handle errors - fetchLMStudioModels already has error handling
            console.debug('Initial LM Studio model fetch failed');
          }
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

    if (provider === 'ollama') {
      // Fetch Ollama models lazily when provider is selected
      try {
        const models = await fetchOllamaModels();
        if (Object.keys(models).length > 0) {
          const defaultModel = Object.keys(models)[0];
          setSelectedModel(defaultModel);
        } else {
          // No models available - show error
          toast.error('No models available in Ollama. Please ensure Ollama server is running and models are downloaded.');
        }
      } catch {
        toast.error('Failed to connect to Ollama. Please ensure the server is running.');
      }
    } else if (provider === 'lmstudio') {
      // Fetch LM Studio models lazily when provider is selected
      try {
        const models = await fetchLMStudioModels();
        if (Object.keys(models).length > 0) {
          const defaultModel = Object.keys(models)[0];
          setSelectedModel(defaultModel);
        } else {
          // No models available - show error
          toast.error('No models available in LM Studio. Please ensure LM Studio server is running and models are loaded.');
        }
      } catch {
        toast.error('Failed to connect to LM Studio. Please ensure the server is running.');
      }
    } else {
      // For other providers, use static models
      const defaultModel = Object.keys(AI_PROVIDERS[provider as keyof typeof AI_PROVIDERS].models)[0];
      setSelectedModel(defaultModel);
    }
  };

  const handleModelChange = (model: string) => {
    setSelectedModel(model);
  };

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

  // Check if a model requires Pro/Business subscription
  const requiresSubscription = (provider: string, model: string): boolean => {
    return provider === 'pagespace' && model === 'glm-4.7';
  };

  // Check if user has access to a model
  const hasModelAccess = (provider: string, model: string): boolean => {
    if (!requiresSubscription(provider, model)) {
      return true; // All users can access non-subscription models
    }

    const userTier = providerSettings?.userSubscriptionTier;
    return userTier === 'pro' || userTier === 'business';
  };

  const isProviderConfigured = (provider: string): boolean => {
    if (!providerSettings?.providers) return false;

    // PageSpace provider should check its own configuration directly
    // (not the user's OpenRouter configuration)
    if (provider === 'pagespace') {
      return providerSettings.providers.pagespace?.isConfigured || false;
    }

    // GLM provider should check its own configuration directly
    // (not the OpenAI configuration, even though GLM uses OpenAI-compatible backend)
    if (provider === 'glm') {
      return providerSettings.providers.glm?.isConfigured || false;
    }

    // MiniMax provider should check its own configuration directly
    // (not the Anthropic configuration, even though MiniMax uses Anthropic-compatible backend)
    if (provider === 'minimax') {
      return providerSettings.providers.minimax?.isConfigured || false;
    }

    // Map UI provider to backend provider for checking configuration
    const backendProvider = getBackendProvider(provider);

    // Check the appropriate provider configuration
    switch (backendProvider) {
      case 'openrouter':
        return providerSettings.providers.openrouter?.isConfigured || false;
      case 'google':
        return providerSettings.providers.google?.isConfigured || false;
      case 'openai':
        return providerSettings.providers.openai?.isConfigured || false;
      case 'anthropic':
        return providerSettings.providers.anthropic?.isConfigured || false;
      case 'xai':
        return providerSettings.providers.xai?.isConfigured || false;
      case 'ollama':
        return providerSettings.providers.ollama?.isConfigured || false;
      case 'lmstudio':
        return providerSettings.providers.lmstudio?.isConfigured || false;
      default:
        return false;
    }
  };

  // Get setProviderSettings from the centralized store
  const setStoreProviderSettings = useAssistantSettingsStore((state) => state.setProviderSettings);

  const handleSaveSettings = async () => {
    setSaving(true);
    try {
      // Don't convert provider - save the UI selection directly
      // PageSpace and OpenRouter are separate providers from the user's perspective

      // Save model selection to backend
      const result = await patch<SaveSettingsResult>('/api/ai/settings', {
        provider: selectedProvider, // Send UI provider directly
        model: selectedModel,
      });

      // Update local state to reflect the saved settings
      if (providerSettings) {
        const updatedSettings = {
          ...providerSettings,
          currentProvider: selectedProvider, // Keep the UI provider
          currentModel: selectedModel,
        };
        setProviderSettings(updatedSettings);
      }

      // Update centralized store (for SidebarChatTab and GlobalAssistantView)
      setStoreProviderSettings(selectedProvider, selectedModel);

      toast.success(result.message || 'Settings saved successfully!');
    } catch (error) {
      console.error('Failed to save settings:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to save settings. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleManageApiKeys = () => {
    router.push('/settings/ai');
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
                  <span className="text-muted-foreground">Provider</span>
                  <Badge variant="secondary">
                    {selectedAgent.aiProvider || 'Default'}
                  </Badge>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Model</span>
                  <Badge variant="secondary">
                    {selectedAgent.aiModel || 'Default'}
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
        {/* Skeleton header */}
        <div className="p-3 border-b">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-4 rounded" />
            <Skeleton className="h-4 w-28" />
          </div>
        </div>
        {/* Skeleton content */}
        <div className="flex-grow p-4 space-y-4">
          {/* Provider selector skeleton */}
          <div className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-10 w-full" />
          </div>
          {/* Model selector skeleton */}
          <div className="space-y-2">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-10 w-full" />
          </div>
          {/* Provider status cards skeleton */}
          <div className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex items-center justify-between p-3 rounded-lg border">
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-4 w-4 rounded-full" />
                    <Skeleton className="h-4 w-20" />
                  </div>
                  <Skeleton className="h-5 w-16 rounded-full" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-3 border-b">
        <h3 className="text-sm font-medium">Global Settings</h3>
      </div>

      {/* Settings Content - with native scrolling */}
      <div className="flex-grow overflow-y-auto">
        <div className="p-4 space-y-4">
          
          {/* Quick Provider Status */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center justify-between">
                <span>Provider Status</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleManageApiKeys}
                  className="h-7 px-2 -mr-2"
                >
                  <Key className="h-3 w-3 mr-1" />
                  Manage Keys
                  <ExternalLink className="h-3 w-3 ml-1" />
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {/* Display all providers dynamically */}
                {Object.entries(AI_PROVIDERS).map(([key, provider]) => {
                  // Skip openrouter_free in the status display as it uses the same key as openrouter
                  if (key === 'openrouter_free') return null;
                  
                  const isConfigured = isProviderConfigured(key);
                  const displayName = key === 'pagespace' ? `${provider.name} (Default)` : provider.name;
                  
                  return (
                    <div key={key} className="flex items-center justify-between text-xs">
                      <span>{displayName}</span>
                      {isConfigured ? (
                        <Badge variant="default" className="text-xs h-5">
                          <CheckCircle className="h-3 w-3 mr-1" />
                          Ready
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs h-5">
                          <XCircle className="h-3 w-3 mr-1" />
                          {key === 'pagespace' ? 'Not Configured' : 'No Key'}
                        </Badge>
                      )}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Provider Selection */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Active Provider</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <label className="text-xs font-medium">Provider</label>
                <Select value={selectedProvider} onValueChange={handleProviderChange}>
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(AI_PROVIDERS).map(([key, provider]) => {
                      const configured = isProviderConfigured(key);
                      return (
                        <SelectItem key={key} value={key}>
                          <div className="flex items-center space-x-2">
                            <span>{provider.name}</span>
                            {configured ? (
                              <CheckCircle className="h-3 w-3 text-green-500" />
                            ) : (
                              <XCircle className="h-3 w-3 text-red-500" />
                            )}
                          </div>
                        </SelectItem>
                      );
                    })}
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
                      const needsSubscription = requiresSubscription(selectedProvider, key);

                      return (
                        <SelectItem
                          key={key}
                          value={key}
                          disabled={!hasAccess}
                        >
                          <div className="flex items-center justify-between w-full">
                            <span className={!hasAccess ? 'text-muted-foreground' : ''}>{name as string}</span>
                            {needsSubscription && !hasAccess && (
                              <Badge variant="outline" className="text-xs ml-2">
                                Pro/Business
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
                disabled={saving}
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

          {/* Upgrade notification for restricted models */}
          {selectedProvider === 'pagespace' &&
           !hasModelAccess('pagespace', 'glm-4.7') && (
            <Card className="border-primary/20 bg-primary/5 dark:bg-primary/10">
              <CardContent className="pt-6">
                <div className="text-center space-y-3">
                  <div className="h-8 w-8 mx-auto rounded-full bg-primary/10 dark:bg-primary/20 flex items-center justify-center">
                    <Zap className="h-4 w-4 text-primary dark:text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-primary dark:text-foreground">
                      Unlock Pro AI
                    </p>
                    <p className="text-xs text-primary/80 dark:text-primary mt-1">
                      Advanced AI reasoning with Pro or Business
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => router.push('/settings/billing')}
                    className="w-full border-primary/30 text-primary hover:bg-primary/10 dark:border-primary/30 dark:text-primary dark:hover:bg-primary/20"
                  >
                    View Upgrade Options
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* API Key Management Link */}
          {!providerSettings?.isAnyProviderConfigured && (
            <Card className="border-orange-200 bg-orange-50 dark:bg-orange-950/20">
              <CardContent className="pt-6">
                <div className="text-center space-y-3">
                  <Key className="h-8 w-8 mx-auto text-orange-600 dark:text-orange-400" />
                  <p className="text-sm text-orange-800 dark:text-orange-200">
                    No API keys configured
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleManageApiKeys}
                    className="w-full"
                  >
                    Configure API Keys
                  </Button>
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
            : 'Configure API keys to enable AI'}
        </div>
      </div>
    </div>
  );
};

export default SidebarSettingsTab;