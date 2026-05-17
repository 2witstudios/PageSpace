'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, ArrowLeft, Server } from 'lucide-react';
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

  const isAvailable = !!data?.providers['pagespace']?.isAvailable;

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
        <h1 className="text-3xl font-bold mb-2">AI Provider</h1>
        <p className="text-muted-foreground">
          PageSpace AI is included with your account and powers all AI features on this instance.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            Available provider
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !data ? (
            <p className="text-sm text-muted-foreground">Could not load provider availability.</p>
          ) : (
            <div className="flex items-center justify-between rounded-md border p-3 max-w-sm">
              <span className="font-medium text-sm">PageSpace AI</span>
              {isAvailable ? (
                <Badge variant="default" className="bg-green-500">
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                  Available
                </Badge>
              ) : (
                <Badge variant="secondary">Unavailable</Badge>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
