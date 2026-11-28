'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Sparkles } from 'lucide-react';
import { fetchWithAuth } from '@/retained/lib/auth/auth-fetch';
import { AI_PROVIDERS } from '@/retained/lib/ai/core/ai-providers-config';
import { isOnPrem } from '@/retained/lib/deployment-mode';
import {
  SettingsGroup,
  SettingsScreen,
  SettingsSection,
} from '@/ui/settings/settings-screen/settings-screen';
import { ChatModelSetting } from './ChatModelSetting';
import { ImageGenerationSetting } from './ImageGenerationSetting';

interface ProviderAvailability {
  isAvailable: boolean;
}

interface ProviderSettingsResponse {
  currentProvider: string;
  currentModel: string;
  userSubscriptionTier?: string;
  isAdmin?: boolean;
  providers: Record<string, ProviderAvailability>;
  isAnyProviderConfigured: boolean;
}

export default function AiSettingsPage() {
  const [data, setData] = useState<ProviderSettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetchWithAuth('/api/ai/settings');
        if (!response.ok) throw new Error('Failed to load settings');
        const json: ProviderSettingsResponse = await response.json();
        if (!cancelled) setData(json);
      } catch (error) {
        console.error('Failed to load AI settings:', error);
        if (!cancelled) toast.error('Failed to load AI provider availability');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const providerEntries = Object.entries(data?.providers ?? {});
  const availableCount = providerEntries.filter(([, p]) => p.isAvailable).length;
  const isAvailable = !!data?.isAnyProviderConfigured;

  return (
    <SettingsScreen
      title="AI providers"
      lede="PageSpace AI is included with your account. Providers are managed for the whole deployment — there are no keys to paste here."
    >
      <div className="flex items-center gap-3 rounded-xl border border-border px-4 py-3">
        <Sparkles className="h-4 w-4 flex-none text-accent-deep" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">PageSpace AI</div>
          <div className="text-xs text-muted-foreground">Powers chat, agents and page AI on this instance</div>
        </div>
        {loading ? (
          <span className="text-sm text-muted-foreground">Loading…</span>
        ) : !data ? (
          <span className="text-sm text-muted-foreground">Could not load provider availability.</span>
        ) : (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <span className={`h-2 w-2 rounded-full ${isAvailable ? 'bg-green-500' : 'bg-muted-foreground/40'}`} aria-hidden="true" />
            {isAvailable ? 'Available' : 'Unavailable'}
          </span>
        )}
      </div>

      {data && (
        <SettingsSection title="Defaults" description="Used when a chat or agent doesn’t pick its own model.">
          <SettingsGroup label="Defaults">
            <ChatModelSetting
              providers={data.providers}
              currentProvider={data.currentProvider}
              currentModel={data.currentModel}
              tier={data.userSubscriptionTier}
              isAdmin={data.isAdmin === true}
              onSaved={(provider, model) =>
                setData((previous) => (previous ? { ...previous, currentProvider: provider, currentModel: model } : previous))
              }
            />
            <ImageGenerationSetting />
          </SettingsGroup>
        </SettingsSection>
      )}

      <SettingsSection
        title="Provider availability"
        description="What this deployment can reach right now."
        actions={
          data ? (
            <span className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{availableCount}</span> of{' '}
              <span className="font-medium text-foreground">{providerEntries.length}</span> available
            </span>
          ) : undefined
        }
      >
        {data && (
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
            {providerEntries.map(([id, status]) => (
              <div key={id} className="flex items-center gap-2 text-sm text-foreground">
                <span
                  className={`h-2 w-2 flex-none rounded-full ${status.isAvailable ? 'bg-green-500' : 'bg-muted-foreground/40'}`}
                  aria-label={status.isAvailable ? 'Available' : 'Unavailable'}
                />
                <span className="truncate">{AI_PROVIDERS[id as keyof typeof AI_PROVIDERS]?.name ?? id}</span>
              </div>
            ))}
          </div>
        )}
        {isOnPrem() && (
          <p className="text-sm text-muted-foreground">
            On self-hosted installs only local providers can be used: Ollama, LM Studio and Azure OpenAI.
          </p>
        )}
      </SettingsSection>
    </SettingsScreen>
  );
}
