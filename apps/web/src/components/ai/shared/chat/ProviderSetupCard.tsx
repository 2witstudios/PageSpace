/**
 * ProviderSetupCard - Card prompting user to set up AI provider
 * Used when no AI providers are configured
 */

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Settings } from 'lucide-react';

interface ProviderSetupCardProps {
  /**
   * Mode: 'redirect' opens settings, 'inline' shows API key input form
   */
  mode?: 'redirect' | 'inline';
  /** Callback when settings should be opened (for redirect mode) */
  onOpenSettings?: () => void;
  /** Callback when API key is submitted (for inline mode) */
  onApiKeySubmit?: (provider: string, apiKey: string) => void;
}

/**
 * Provider setup card shown when no AI providers are configured
 */
export const ProviderSetupCard: React.FC<ProviderSetupCardProps> = ({
  mode = 'redirect',
  onOpenSettings,
  onApiKeySubmit,
}) => {
  const [selectedProvider, setSelectedProvider] = useState<string>('openrouter');
  const [apiKey, setApiKey] = useState<string>('');

  const handleSubmit = () => {
    if (apiKey.trim() && onApiKeySubmit) {
      onApiKeySubmit(selectedProvider, apiKey);
    }
  };

  // Redirect mode - simple card with button to open settings
  if (mode === 'redirect') {
    return (
      <div className="flex flex-col h-full p-4">
        <div className="flex-grow flex items-center justify-center">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <Settings className="h-5 w-5" />
                <span>AI Provider Setup Required</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                You need to configure an AI provider before you can start chatting. Click
                the button below to open settings and add your API keys.
              </p>

              <Button onClick={onOpenSettings} className="w-full">
                <Settings className="h-4 w-4 mr-2" />
                Open Settings
              </Button>

              <div className="text-xs text-muted-foreground text-center">
                You can configure OpenRouter or Google AI providers. Your API keys are
                encrypted and stored securely.
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // Inline mode - full API key input form
  return (
    <div className="flex flex-col h-full p-4">
      <div className="flex-grow flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Settings className="h-5 w-5" />
              <span>AI Provider Setup</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Choose an AI provider and enter your API key to start chatting. Your keys
              are encrypted and stored securely.
            </p>

            <div className="space-y-3">
              <div className="space-y-2">
                <label className="text-sm font-medium">Provider</label>
                <Select value={selectedProvider} onValueChange={setSelectedProvider}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openrouter">OpenRouter</SelectItem>
                    <SelectItem value="google">Google AI</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">API Key</label>
                <Input
                  type="password"
                  placeholder={
                    selectedProvider === 'openrouter'
                      ? 'Enter your OpenRouter API key'
                      : 'Enter your Google AI API key'
                  }
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleSubmit();
                    }
                  }}
                />
              </div>

              <Button
                onClick={handleSubmit}
                disabled={!apiKey.trim()}
                className="w-full"
              >
                Save API Key
              </Button>
            </div>

            <div className="text-xs text-muted-foreground">
              {selectedProvider === 'openrouter' ? (
                <>
                  Get your API key from{' '}
                  <a
                    href="https://openrouter.ai/keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    openrouter.ai/keys
                  </a>
                </>
              ) : (
                <>
                  Get your API key from{' '}
                  <a
                    href="https://aistudio.google.com/app/apikey"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    Google AI Studio
                  </a>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
