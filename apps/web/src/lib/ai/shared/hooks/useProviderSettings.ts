/**
 * useProviderSettings - Shared hook for AI provider configuration
 * Used by both Agent engine and Global Assistant engine
 */

import { useState, useEffect, useCallback } from 'react';
import { fetchWithAuth } from '@/lib/auth-fetch';
import { getBackendProvider } from '@/lib/ai/ai-providers-config';
import type { ProviderSettings } from '../chat-types';

interface UseProviderSettingsOptions {
  /**
   * Optional page ID for page-specific settings
   */
  pageId?: string;
}

interface UseProviderSettingsResult {
  /** Provider settings from backend */
  providerSettings: ProviderSettings | null;
  /** Whether any provider is configured */
  isAnyProviderConfigured: boolean;
  /** Whether settings require setup (no providers configured) */
  needsSetup: boolean;
  /** Selected provider */
  selectedProvider: string;
  /** Set selected provider */
  setSelectedProvider: (provider: string) => void;
  /** Selected model */
  selectedModel: string;
  /** Set selected model */
  setSelectedModel: (model: string) => void;
  /** Check if a specific provider is configured */
  isProviderConfigured: (provider: string) => boolean;
  /** Reload provider settings */
  refresh: () => Promise<void>;
}

/**
 * Hook for managing AI provider settings
 * Handles loading, caching, and checking provider configuration
 */
export function useProviderSettings({
  pageId,
}: UseProviderSettingsOptions = {}): UseProviderSettingsResult {
  const [providerSettings, setProviderSettings] = useState<ProviderSettings | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string>('pagespace');
  const [selectedModel, setSelectedModel] = useState<string>('');

  // Load provider settings
  const loadProviderSettings = useCallback(async () => {
    try {
      const endpoint = pageId ? `/api/ai/chat?pageId=${pageId}` : '/api/ai/chat';
      const response = await fetchWithAuth(endpoint);

      if (response.ok) {
        const data: ProviderSettings = await response.json();
        setProviderSettings(data);

        // Set current provider and model from server
        setSelectedProvider(data.currentProvider);
        setSelectedModel(data.currentModel);
      }
    } catch (error) {
      console.error('Failed to load provider settings:', error);
    }
  }, [pageId]);

  // Load on mount
  useEffect(() => {
    loadProviderSettings();
  }, [loadProviderSettings]);

  // Check if a specific provider is configured
  const isProviderConfigured = useCallback(
    (provider: string): boolean => {
      if (!providerSettings) return false;

      // PageSpace provider check
      if (provider === 'pagespace') {
        return providerSettings.providers.pagespace?.isConfigured || false;
      }

      // GLM provider check
      if (provider === 'glm') {
        return providerSettings.providers.glm?.isConfigured || false;
      }

      // Map UI provider to backend provider for checking configuration
      const backendProvider = getBackendProvider(provider);

      // For openrouter_free, check the openrouter configuration
      if (backendProvider === 'openrouter') {
        return providerSettings.providers.openrouter?.isConfigured || false;
      }

      const providerConfig =
        providerSettings.providers[
          backendProvider as keyof typeof providerSettings.providers
        ];
      return providerConfig?.isConfigured || false;
    },
    [providerSettings]
  );

  // Derived state
  const isAnyProviderConfigured = providerSettings?.isAnyProviderConfigured || false;
  const needsSetup = !isAnyProviderConfigured;

  return {
    providerSettings,
    isAnyProviderConfigured,
    needsSetup,
    selectedProvider,
    setSelectedProvider,
    selectedModel,
    setSelectedModel,
    isProviderConfigured,
    refresh: loadProviderSettings,
  };
}
