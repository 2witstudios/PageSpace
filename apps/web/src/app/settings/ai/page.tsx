'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, ArrowLeft, Server, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

interface ProviderAvailability {
  isAvailable: boolean;
}

interface ProviderSettingsResponse {
  currentProvider: string;
  currentModel: string;
  pageSpaceBackend: 'glm' | 'google' | 'openrouter' | null;
  providers: Record<string, ProviderAvailability>;
}

const PROVIDER_LABELS: Record<string, string> = {
  pagespace: 'PageSpace AI',
  openrouter: 'OpenRouter',
  openrouter_free: 'OpenRouter (Free models)',
  google: 'Google AI',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  xai: 'xAI (Grok)',
  ollama: 'Ollama (Local)',
  lmstudio: 'LM Studio (Local)',
  glm: 'GLM Coder Plan',
  minimax: 'MiniMax',
  azure_openai: 'Azure OpenAI',
};

export default function AiSettingsPage() {
  const router = useRouter();
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

  const orderedProviders = Object.keys(PROVIDER_LABELS);
  const availableCount = data
    ? orderedProviders.filter((p) => data.providers[p]?.isAvailable).length
    : 0;

  return (
    <div className="container mx-auto py-10 space-y-8 px-10">
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
        <h1 className="text-3xl font-bold mb-2">AI Providers</h1>
        <p className="text-muted-foreground">
          AI provider credentials are managed at the deployment level. This page
          shows which providers are configured on this PageSpace instance and which
          you can select in the model picker.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            Available providers
            {data && (
              <Badge variant="secondary" className="ml-2">
                {availableCount} of {orderedProviders.length}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !data ? (
            <p className="text-sm text-muted-foreground">Could not load provider availability.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {orderedProviders.map((id) => {
                const label = PROVIDER_LABELS[id];
                const available = !!data.providers[id]?.isAvailable;
                return (
                  <div
                    key={id}
                    className="flex items-center justify-between rounded-md border p-3"
                  >
                    <span className="font-medium text-sm">{label}</span>
                    {available ? (
                      <Badge variant="default" className="bg-green-500">
                        <CheckCircle2 className="h-3 w-3 mr-1" />
                        Available
                      </Badge>
                    ) : (
                      <Badge variant="secondary">Unavailable</Badge>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground flex gap-3">
        <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
        <div>
          PageSpace no longer accepts per-user API keys. To add a new provider,
          a deployment operator needs to set the matching{' '}
          <code className="text-xs bg-muted px-1 rounded">*_DEFAULT_API_KEY</code>{' '}
          environment variable (or base URL for local providers like Ollama and
          LM Studio).
        </div>
      </div>
    </div>
  );
}
