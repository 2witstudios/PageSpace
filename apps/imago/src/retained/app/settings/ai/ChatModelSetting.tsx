'use client';

import { useEffect, useMemo, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/retained/components/ui/select';
import { toast } from 'sonner';
import { fetchWithAuth, patch } from '@/retained/lib/auth/auth-fetch';
import { SettingsRow } from '@/ui/settings/settings-screen/settings-screen';
import {
  buildChatModelOptions,
  chatModelValue,
  type DynamicModels,
  type ProviderAvailabilityStatus,
} from './chat-model-options';

/** Local providers whose model lists are discovered at runtime, and where each list comes from. */
const DYNAMIC_MODEL_PATHS: Readonly<Record<string, string>> = {
  ollama: '/api/ai/ollama/models',
  lmstudio: '/api/ai/lmstudio/models',
};

export interface ChatModelSettingProps {
  readonly providers: Readonly<Record<string, ProviderAvailabilityStatus>>;
  readonly currentProvider: string;
  readonly currentModel: string;
  readonly tier: string | undefined;
  readonly isAdmin: boolean;
  readonly onSaved: (provider: string, model: string) => void;
}

/** The chat-model default: saved with PATCH /api/ai/settings, as the chat composer's selector does. */
export function ChatModelSetting({ providers, currentProvider, currentModel, tier, isAdmin, onSaved }: ChatModelSettingProps) {
  const [dynamicModels, setDynamicModels] = useState<DynamicModels>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const loaded: Record<string, Record<string, string>> = {};
      for (const [provider, path] of Object.entries(DYNAMIC_MODEL_PATHS)) {
        if (!providers[provider]?.isAvailable) continue;
        try {
          const res = await fetchWithAuth(path);
          if (!res.ok) continue;
          const data = await res.json();
          if (data.success && data.models) loaded[provider] = data.models;
        } catch {
          // A local server that is down simply offers no models for its provider.
        }
      }
      if (!cancelled) setDynamicModels(loaded);
    })();
    return () => { cancelled = true; };
  }, [providers]);

  const options = useMemo(
    () => buildChatModelOptions({ providers, tier, isAdmin, dynamicModels }),
    [providers, tier, isAdmin, dynamicModels],
  );

  const selectedValue = options.find((o) => o.value === chatModelValue(currentProvider, currentModel))?.value;

  async function onChange(value: string) {
    const option = options.find((o) => o.value === value);
    if (!option) return;
    setSaving(true);
    try {
      await patch('/api/ai/settings', { provider: option.provider, model: option.model });
      onSaved(option.provider, option.model);
      window.dispatchEvent(new Event('ai-settings-updated'));
      toast.success('Chat model updated');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update chat model');
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsRow label="Chat model" hint="Only providers available here can be chosen.">
      <Select value={selectedValue} onValueChange={onChange} disabled={saving || options.length === 0}>
        <SelectTrigger aria-label="Chat model" className="w-72">
          <SelectValue placeholder={options.length === 0 ? 'No provider available' : 'Select a model'} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsRow>
  );
}
