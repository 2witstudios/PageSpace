import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Settings, CheckCircle, XCircle, Key, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { AI_PROVIDERS, getBackendProvider } from '@/lib/ai/ai-providers-config';

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
    glm: { isConfigured: boolean; hasApiKey: boolean };
  };
  isAnyProviderConfigured: boolean;
}

const AssistantSettingsTab: React.FC = () => {
  const router = useRouter();
  const [providerSettings, setProviderSettings] = useState<ProviderSettings | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string>('pagespace');
  const [selectedModel, setSelectedModel] = useState<string>('qwen/qwen3-coder:free');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Dynamic Ollama models state
  const [ollamaModels, setOllamaModels] = useState<Record<string, string> | null>(null);
  const [ollamaModelsLoading, setOllamaModelsLoading] = useState(false);
  const [ollamaModelsError, setOllamaModelsError] = useState<string | null>(null);

  // Fetch Ollama models dynamically
  const fetchOllamaModels = useCallback(async () => {
    // Return cached results if available
    if (ollamaModels) {
      return ollamaModels;
    }

    setOllamaModelsLoading(true);
    setOllamaModelsError(null);

    try {
      const response = await fetch('/api/ai/ollama/models');
      const data = await response.json();

      if (data.success && data.models) {
        setOllamaModels(data.models);
        return data.models;
      } else {
        // Use fallback models if fetch failed but returned data
        const fallbackModels = AI_PROVIDERS.ollama.models;
        setOllamaModels(fallbackModels);
        setOllamaModelsError(data.error || 'Using fallback models');
        return fallbackModels;
      }
    } catch (error) {
      console.error('Failed to fetch Ollama models:', error);
      // Use static fallback models
      const fallbackModels = AI_PROVIDERS.ollama.models;
      setOllamaModels(fallbackModels);
      setOllamaModelsError('Connection failed. Using fallback models.');
      return fallbackModels;
    } finally {
      setOllamaModelsLoading(false);
    }
  }, [ollamaModels]);

  // Load current settings
  const loadSettings = useCallback(async () => {
    try {
      const response = await fetch('/api/ai/settings');
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

        // If current provider is Ollama, eagerly fetch models to avoid empty dropdown
        if (uiProvider === 'ollama') {
          try {
            await fetchOllamaModels();
          } catch {
            // Silently handle errors - fetchOllamaModels already has error handling
            console.debug('Initial Ollama model fetch failed, will use fallback models');
          }
        }
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
    } finally {
      setLoading(false);
    }
  }, [fetchOllamaModels]);

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
        const defaultModel = Object.keys(models)[0];
        setSelectedModel(defaultModel);
      } catch {
        // Fallback to static models
        const defaultModel = Object.keys(AI_PROVIDERS.ollama.models)[0];
        setSelectedModel(defaultModel);
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

  // Get models for the current provider (dynamic for Ollama, static for others)
  const getCurrentProviderModels = () => {
    if (selectedProvider === 'ollama' && ollamaModels) {
      return ollamaModels;
    }
    return AI_PROVIDERS[selectedProvider as keyof typeof AI_PROVIDERS]?.models || {};
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
      default:
        return false;
    }
  };

  const handleSaveSettings = async () => {
    setSaving(true);
    try {
      // Don't convert provider - save the UI selection directly
      // PageSpace and OpenRouter are separate providers from the user's perspective
      
      // Save model selection to backend
      const response = await fetch('/api/ai/settings', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: selectedProvider, // Send UI provider directly
          model: selectedModel,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to save settings');
      }

      const result = await response.json();
      
      // Update local state to reflect the saved settings
      if (providerSettings) {
        const updatedSettings = {
          ...providerSettings,
          currentProvider: selectedProvider, // Keep the UI provider
          currentModel: selectedModel,
        };
        setProviderSettings(updatedSettings);
      }
      
      // Broadcast settings update event for other components
      window.dispatchEvent(new CustomEvent('ai-settings-updated', {
        detail: { provider: selectedProvider, model: selectedModel }
      }));
      
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

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="p-4 border-b">
          <h3 className="text-sm font-medium">Settings</h3>
        </div>
        <div className="flex-grow flex items-center justify-center">
          <div className="text-sm text-muted-foreground">Loading settings...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-3 border-b">
        <h3 className="text-sm font-medium flex items-center space-x-2">
          <Settings className="h-4 w-4" />
          <span>Settings</span>
        </h3>
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
                    {Object.entries(getCurrentProviderModels()).map(([key, name]) => (
                      <SelectItem key={key} value={key}>
                        {name}
                      </SelectItem>
                    ))}
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

export default AssistantSettingsTab;