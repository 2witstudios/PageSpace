'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Eye, EyeOff, CheckCircle, Key, AlertTriangle, ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import {
  Alert,
  AlertDescription,
} from '@/components/ui/alert';

interface ProviderSettings {
  currentProvider: string;
  currentModel: string;
  providers: {
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

export default function AiSettingsPage() {
  const router = useRouter();
  const [providerSettings, setProviderSettings] = useState<ProviderSettings | null>(null);
  const [openRouterApiKey, setOpenRouterApiKey] = useState<string>('');
  const [googleApiKey, setGoogleApiKey] = useState<string>('');
  const [openAIApiKey, setOpenAIApiKey] = useState<string>('');
  const [anthropicApiKey, setAnthropicApiKey] = useState<string>('');
  const [xaiApiKey, setXaiApiKey] = useState<string>('');
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState<string>('');
  const [glmApiKey, setGlmApiKey] = useState<string>('');
  const [showOpenRouterKey, setShowOpenRouterKey] = useState<boolean>(false);
  const [showGoogleKey, setShowGoogleKey] = useState<boolean>(false);
  const [showOpenAIKey, setShowOpenAIKey] = useState<boolean>(false);
  const [showAnthropicKey, setShowAnthropicKey] = useState<boolean>(false);
  const [showXaiKey, setShowXaiKey] = useState<boolean>(false);
  const [showGlmKey, setShowGlmKey] = useState<boolean>(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Load current settings
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const response = await fetch('/api/ai/settings');
        if (response.ok) {
          const data: ProviderSettings = await response.json();
          setProviderSettings(data);
        } else {
          throw new Error('Failed to load settings');
        }
      } catch (error) {
        console.error('Failed to load settings:', error);
        toast.error('Failed to load AI settings');
      } finally {
        setLoading(false);
      }
    };

    loadSettings();
  }, []);

  const isProviderConfigured = (provider: string): boolean => {
    return providerSettings?.providers[provider as keyof typeof providerSettings.providers]?.isConfigured || false;
  };

  const handleSaveApiKey = async (provider: 'openrouter' | 'google' | 'openai' | 'anthropic' | 'xai' | 'glm') => {
    setSaving(true);
    try {
      let apiKey = '';
      switch (provider) {
        case 'openrouter':
          apiKey = openRouterApiKey;
          break;
        case 'google':
          apiKey = googleApiKey;
          break;
        case 'openai':
          apiKey = openAIApiKey;
          break;
        case 'anthropic':
          apiKey = anthropicApiKey;
          break;
        case 'xai':
          apiKey = xaiApiKey;
          break;
        case 'glm':
          apiKey = glmApiKey;
          break;
      }

      if (!apiKey.trim()) {
        toast.error('Please enter an API key');
        setSaving(false);
        return;
      }

      // Save API key to backend
      const response = await fetch('/api/ai/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider,
          apiKey: apiKey.trim(),
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to save API key');
      }

      const result = await response.json();

      // Update provider settings locally
      if (providerSettings) {
        const updatedSettings = {
          ...providerSettings,
          providers: {
            ...providerSettings.providers,
            [provider]: {
              isConfigured: true,
              hasApiKey: true,
            },
          },
          isAnyProviderConfigured: true,
        };
        setProviderSettings(updatedSettings);
      }

      // Clear the input field for security
      switch (provider) {
        case 'openrouter':
          setOpenRouterApiKey('');
          break;
        case 'google':
          setGoogleApiKey('');
          break;
        case 'openai':
          setOpenAIApiKey('');
          break;
        case 'anthropic':
          setAnthropicApiKey('');
          break;
        case 'xai':
          setXaiApiKey('');
          break;
        case 'glm':
          setGlmApiKey('');
          break;
      }

      // Broadcast settings update event for other components
      window.dispatchEvent(new CustomEvent('ai-settings-updated', {
        detail: { provider, apiKeySaved: true }
      }));

      toast.success(result.message || `API key saved successfully!`);
    } catch (error) {
      console.error('Failed to save API key:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to save API key. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveOllamaBaseUrl = async () => {
    setSaving(true);
    try {
      if (!ollamaBaseUrl.trim()) {
        toast.error('Please enter a base URL');
        setSaving(false);
        return;
      }

      // Format the base URL - store user input as-is (backend will add /api when needed)
      let formattedUrl = ollamaBaseUrl.trim();

      // Remove trailing slash if present
      formattedUrl = formattedUrl.replace(/\/$/, '');

      // Save Ollama base URL to backend
      const response = await fetch('/api/ai/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'ollama',
          baseUrl: formattedUrl,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to save Ollama base URL');
      }

      const result = await response.json();

      // Update provider settings locally
      if (providerSettings) {
        const updatedSettings = {
          ...providerSettings,
          providers: {
            ...providerSettings.providers,
            ollama: {
              isConfigured: true,
              hasBaseUrl: true,
            },
          },
          isAnyProviderConfigured: true,
        };
        setProviderSettings(updatedSettings);
      }

      // Clear the input field
      setOllamaBaseUrl('');

      // Broadcast settings update event for other components
      window.dispatchEvent(new CustomEvent('ai-settings-updated', {
        detail: { provider: 'ollama', baseUrlSaved: true }
      }));

      toast.success(result.message || 'Ollama base URL saved successfully!');
    } catch (error) {
      console.error('Failed to save Ollama base URL:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to save Ollama base URL. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="container mx-auto py-10 px-10">
        <h1 className="text-3xl font-bold mb-6">AI API Keys</h1>
        <p className="text-muted-foreground">Loading settings...</p>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-10 space-y-10 px-10">
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/settings')}
          className="mb-4"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Settings
        </Button>
        <h1 className="text-3xl font-bold mb-6">AI API Keys</h1>
        <p className="mb-8 text-muted-foreground">
          Configure your AI provider API keys to enable AI features throughout the application.
          Your keys are encrypted and stored securely.
        </p>
      </div>

      {/* Provider Status Overview */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            Provider Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <div className="flex items-center justify-between p-3 border rounded-lg">
              <span className="font-medium">OpenRouter</span>
              {isProviderConfigured('openrouter') ? (
                <Badge variant="default" className="bg-green-500">
                  <CheckCircle className="h-3 w-3 mr-1" />
                  Configured
                </Badge>
              ) : (
                <Badge variant="secondary">Not Configured</Badge>
              )}
            </div>
            <div className="flex items-center justify-between p-3 border rounded-lg">
              <span className="font-medium">Google AI</span>
              {isProviderConfigured('google') ? (
                <Badge variant="default" className="bg-green-500">
                  <CheckCircle className="h-3 w-3 mr-1" />
                  Configured
                </Badge>
              ) : (
                <Badge variant="secondary">Not Configured</Badge>
              )}
            </div>
            <div className="flex items-center justify-between p-3 border rounded-lg">
              <span className="font-medium">OpenAI</span>
              {isProviderConfigured('openai') ? (
                <Badge variant="default" className="bg-green-500">
                  <CheckCircle className="h-3 w-3 mr-1" />
                  Configured
                </Badge>
              ) : (
                <Badge variant="secondary">Not Configured</Badge>
              )}
            </div>
            <div className="flex items-center justify-between p-3 border rounded-lg">
              <span className="font-medium">Anthropic</span>
              {isProviderConfigured('anthropic') ? (
                <Badge variant="default" className="bg-green-500">
                  <CheckCircle className="h-3 w-3 mr-1" />
                  Configured
                </Badge>
              ) : (
                <Badge variant="secondary">Not Configured</Badge>
              )}
            </div>
            <div className="flex items-center justify-between p-3 border rounded-lg">
              <span className="font-medium">xAI (Grok)</span>
              {isProviderConfigured('xai') ? (
                <Badge variant="default" className="bg-green-500">
                  <CheckCircle className="h-3 w-3 mr-1" />
                  Configured
                </Badge>
              ) : (
                <Badge variant="secondary">Not Configured</Badge>
              )}
            </div>
            <div className="flex items-center justify-between p-3 border rounded-lg">
              <span className="font-medium">Ollama (Local)</span>
              {isProviderConfigured('ollama') ? (
                <Badge variant="default" className="bg-green-500">
                  <CheckCircle className="h-3 w-3 mr-1" />
                  Configured
                </Badge>
              ) : (
                <Badge variant="secondary">Not Configured</Badge>
              )}
            </div>
            <div className="flex items-center justify-between p-3 border rounded-lg">
              <span className="font-medium">GLM Coder Plan</span>
              {isProviderConfigured('glm') ? (
                <Badge variant="default" className="bg-green-500">
                  <CheckCircle className="h-3 w-3 mr-1" />
                  Configured
                </Badge>
              ) : (
                <Badge variant="secondary">Not Configured</Badge>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* OpenRouter API Key */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>OpenRouter API Key</span>
            {isProviderConfigured('openrouter') && (
              <Badge variant="default" className="bg-green-500">
                <CheckCircle className="h-3 w-3 mr-1" />
                Configured
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">API Key</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  type={showOpenRouterKey ? "text" : "password"}
                  placeholder="Enter your OpenRouter API key"
                  value={openRouterApiKey}
                  onChange={(e) => setOpenRouterApiKey(e.target.value)}
                  className="pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-0 top-0 h-full px-3"
                  onClick={() => setShowOpenRouterKey(!showOpenRouterKey)}
                >
                  {showOpenRouterKey ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <Button
                onClick={() => handleSaveApiKey('openrouter')}
                disabled={!openRouterApiKey.trim() || saving}
              >
                {saving ? 'Saving...' : 'Save Key'}
              </Button>
            </div>
          </div>
          <div className="text-sm text-muted-foreground">
            <p>Get your API key from{' '}
              <a
                href="https://openrouter.ai/keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline"
              >
                openrouter.ai/keys
              </a>
            </p>
            <p className="mt-2">OpenRouter provides access to Claude, GPT-4, Llama, and many other models.</p>
          </div>
        </CardContent>
      </Card>

      {/* Google AI API Key */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Google AI API Key</span>
            {isProviderConfigured('google') && (
              <Badge variant="default" className="bg-green-500">
                <CheckCircle className="h-3 w-3 mr-1" />
                Configured
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">API Key</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  type={showGoogleKey ? "text" : "password"}
                  placeholder="Enter your Google AI API key"
                  value={googleApiKey}
                  onChange={(e) => setGoogleApiKey(e.target.value)}
                  className="pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-0 top-0 h-full px-3"
                  onClick={() => setShowGoogleKey(!showGoogleKey)}
                >
                  {showGoogleKey ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <Button
                onClick={() => handleSaveApiKey('google')}
                disabled={!googleApiKey.trim() || saving}
              >
                {saving ? 'Saving...' : 'Save Key'}
              </Button>
            </div>
          </div>
          <div className="text-sm text-muted-foreground">
            <p>Get your API key from{' '}
              <a
                href="https://aistudio.google.com/app/apikey"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline"
              >
                Google AI Studio
              </a>
            </p>
            <p className="mt-2">Google AI provides access to Gemini models with advanced capabilities.</p>
          </div>
        </CardContent>
      </Card>

      {/* OpenAI API Key */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>OpenAI API Key</span>
            {isProviderConfigured('openai') && (
              <Badge variant="default" className="bg-green-500">
                <CheckCircle className="h-3 w-3 mr-1" />
                Configured
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">API Key</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  type={showOpenAIKey ? "text" : "password"}
                  placeholder="Enter your OpenAI API key"
                  value={openAIApiKey}
                  onChange={(e) => setOpenAIApiKey(e.target.value)}
                  className="pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-0 top-0 h-full px-3"
                  onClick={() => setShowOpenAIKey(!showOpenAIKey)}
                >
                  {showOpenAIKey ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <Button
                onClick={() => handleSaveApiKey('openai')}
                disabled={!openAIApiKey.trim() || saving}
              >
                {saving ? 'Saving...' : 'Save Key'}
              </Button>
            </div>
          </div>
          <div className="text-sm text-muted-foreground">
            <p>Get your API key from{' '}
              <a
                href="https://platform.openai.com/api-keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline"
              >
                platform.openai.com
              </a>
            </p>
            <p className="mt-2">OpenAI provides access to GPT-5, GPT-4o, O3, and other advanced models.</p>
          </div>
        </CardContent>
      </Card>

      {/* Anthropic API Key */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Anthropic API Key</span>
            {isProviderConfigured('anthropic') && (
              <Badge variant="default" className="bg-green-500">
                <CheckCircle className="h-3 w-3 mr-1" />
                Configured
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">API Key</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  type={showAnthropicKey ? "text" : "password"}
                  placeholder="Enter your Anthropic API key"
                  value={anthropicApiKey}
                  onChange={(e) => setAnthropicApiKey(e.target.value)}
                  className="pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-0 top-0 h-full px-3"
                  onClick={() => setShowAnthropicKey(!showAnthropicKey)}
                >
                  {showAnthropicKey ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <Button
                onClick={() => handleSaveApiKey('anthropic')}
                disabled={!anthropicApiKey.trim() || saving}
              >
                {saving ? 'Saving...' : 'Save Key'}
              </Button>
            </div>
          </div>
          <div className="text-sm text-muted-foreground">
            <p>Get your API key from{' '}
              <a
                href="https://console.anthropic.com/settings/keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline"
              >
                console.anthropic.com
              </a>
            </p>
            <p className="mt-2">Anthropic provides access to Claude Opus 4.1, Sonnet 4.1, and other Claude models.</p>
          </div>
        </CardContent>
      </Card>

      {/* xAI (Grok) API Key */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>xAI (Grok) API Key</span>
            {isProviderConfigured('xai') && (
              <Badge variant="default" className="bg-green-500">
                <CheckCircle className="h-3 w-3 mr-1" />
                Configured
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">API Key</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  type={showXaiKey ? "text" : "password"}
                  placeholder="Enter your xAI API key"
                  value={xaiApiKey}
                  onChange={(e) => setXaiApiKey(e.target.value)}
                  className="pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-0 top-0 h-full px-3"
                  onClick={() => setShowXaiKey(!showXaiKey)}
                >
                  {showXaiKey ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <Button
                onClick={() => handleSaveApiKey('xai')}
                disabled={!xaiApiKey.trim() || saving}
              >
                {saving ? 'Saving...' : 'Save Key'}
              </Button>
            </div>
          </div>
          <div className="text-sm text-muted-foreground">
            <p>Get your API key from{' '}
              <a
                href="https://console.x.ai/team"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline"
              >
                console.x.ai
              </a>
            </p>
            <p className="mt-2">xAI provides access to Grok 4, Grok 3, and other Grok models with reasoning capabilities.</p>
          </div>
        </CardContent>
      </Card>

      {/* Ollama Base URL */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Ollama (Local AI)</span>
            {isProviderConfigured('ollama') && (
              <Badge variant="default" className="bg-green-500">
                <CheckCircle className="h-3 w-3 mr-1" />
                Configured
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Base URL</label>
            <div className="flex gap-2">
              <Input
                type="text"
                placeholder="http://localhost:11434"
                value={ollamaBaseUrl}
                onChange={(e) => setOllamaBaseUrl(e.target.value)}
                className="flex-1"
              />
              <Button
                onClick={handleSaveOllamaBaseUrl}
                disabled={!ollamaBaseUrl.trim() || saving}
              >
                {saving ? 'Saving...' : 'Save URL'}
              </Button>
            </div>
          </div>
          <div className="text-sm text-muted-foreground">
            <p>Enter your Ollama server base URL. <code>/api</code> will be added automatically.</p>
            <p className="mt-1">
              <strong>Examples:</strong> <code>http://localhost:11434</code> or <code>http://host.docker.internal:11434</code>
            </p>
            <p className="mt-2">
              Install Ollama from{' '}
              <a
                href="https://ollama.ai"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline"
              >
                ollama.ai
              </a>
              {' '}to run local AI models without API costs.
            </p>
            <p className="mt-2">
              <strong>Popular models:</strong> llama3.2, codellama, mistral, qwen2.5-coder, gemma2
            </p>
          </div>
        </CardContent>
      </Card>

      {/* GLM Coder Plan API Key */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>GLM Coder Plan API Key</span>
            {isProviderConfigured('glm') && (
              <Badge variant="default" className="bg-green-500">
                <CheckCircle className="h-3 w-3 mr-1" />
                Configured
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">API Key</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  type={showGlmKey ? "text" : "password"}
                  placeholder="Enter your GLM Coder Plan API key"
                  value={glmApiKey}
                  onChange={(e) => setGlmApiKey(e.target.value)}
                  className="pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-0 top-0 h-full px-3"
                  onClick={() => setShowGlmKey(!showGlmKey)}
                >
                  {showGlmKey ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <Button
                onClick={() => handleSaveApiKey('glm')}
                disabled={!glmApiKey.trim() || saving}
              >
                {saving ? 'Saving...' : 'Save Key'}
              </Button>
            </div>
          </div>
          <div className="text-sm text-muted-foreground">
            <p>Get your API key from{' '}
              <a
                href="https://z.ai/manage-apikey/apikey-list"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline"
              >
                Z.AI Platform
              </a>
            </p>
            <p className="mt-2">GLM Coder Plan provides access to GLM-4.5 and GLM-4.5-air models optimized for coding tasks.</p>
            <p className="mt-1">
              <strong>Subscription required:</strong> You need an active GLM Coder Plan subscription from Z.AI to use these models.
            </p>
          </div>
        </CardContent>
      </Card>

      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>
          <strong>Security Notice:</strong> API keys are encrypted before storage and are never exposed in the browser.
          Only configure API keys from trusted providers. You can update or remove keys at any time.
        </AlertDescription>
      </Alert>
    </div>
  );
}