'use client';

import { useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Sparkles, Lock } from 'lucide-react';
import { fetchWithAuth, patch } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';

interface AutomationView {
  pulse: { enabled: boolean };
  memory: { enabled: boolean; available: boolean };
}

const fetcher = async (url: string): Promise<AutomationView> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
  return response.json();
};

/**
 * Controls for the system AI cron jobs that spend credits automatically: the daily
 * Pulse summary and conversation Memory. Reads/writes `/api/settings/automations`.
 * Memory is paid-only — for free users the toggle is locked with an upgrade link.
 */
export function AutomationsCard() {
  const { data, error, isLoading, mutate } = useSWR<AutomationView>(
    '/api/settings/automations',
    fetcher,
    { revalidateOnFocus: false },
  );
  const [saving, setSaving] = useState<'pulse' | 'memory' | null>(null);

  const update = async (field: 'pulseEnabled' | 'memoryEnabled', value: boolean) => {
    setSaving(field === 'pulseEnabled' ? 'pulse' : 'memory');
    // Optimistic update.
    const optimistic: AutomationView | undefined = data && {
      pulse: { enabled: field === 'pulseEnabled' ? value : data.pulse.enabled },
      memory: {
        ...data.memory,
        enabled: field === 'memoryEnabled' ? value : data.memory.enabled,
      },
    };
    try {
      await mutate(
        async () => {
          const updated = await patch<AutomationView>('/api/settings/automations', { [field]: value });
          return updated;
        },
        { optimisticData: optimistic, rollbackOnError: true, revalidate: false },
      );
    } catch {
      toast.error('Could not update automation setting. Please try again.');
    } finally {
      setSaving(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5" />
          Automations
        </CardTitle>
        <CardDescription>
          Background AI that runs on your behalf. Turning these off stops them from
          spending your credits automatically.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : error || !data ? (
          <p className="text-sm text-muted-foreground">
            Could not load automation settings. Please refresh and try again.
          </p>
        ) : (
          <div className="divide-y">
            <ToggleRow
              title="Pulse"
              description="A short daily summary of what changed in your workspace."
              checked={data.pulse.enabled}
              disabled={saving === 'pulse'}
              onCheckedChange={(v) => update('pulseEnabled', v)}
            />
            {data.memory.available ? (
              <ToggleRow
                title="Memory"
                description="Learns your preferences from conversations to personalize AI replies."
                checked={data.memory.enabled}
                disabled={saving === 'memory'}
                onCheckedChange={(v) => update('memoryEnabled', v)}
              />
            ) : (
              <div className="flex items-center justify-between gap-4 py-4">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    Memory
                    <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Learns your preferences from conversations.{' '}
                    <Link href="/settings/plan" className="underline underline-offset-2">
                      Upgrade to enable
                    </Link>
                    .
                  </p>
                </div>
                <Switch checked={false} disabled aria-label="Memory (upgrade required)" />
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ToggleRow({
  title,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-4">
      <div className="space-y-0.5">
        <div className="text-sm font-medium">{title}</div>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-label={title}
      />
    </div>
  );
}
