'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { ImageIcon, Loader2, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { fetchWithAuth, patch } from '@/lib/auth/auth-fetch';
import { isImageGenerationAllowedForTier } from '@/lib/ai/core/image-gen-access';

interface ImageModel {
  id: string;
  displayName: string;
}

const NONE = '__none__';

export function ImageGenerationCard() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tier, setTier] = useState<string>('free');
  const [selected, setSelected] = useState<string | null>(null);
  const [models, setModels] = useState<ImageModel[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [settingsRes, modelsRes] = await Promise.all([
          fetchWithAuth('/api/ai/settings'),
          fetchWithAuth('/api/ai/image-models'),
        ]);
        if (!settingsRes.ok) throw new Error('settings');
        const settings = await settingsRes.json();
        const modelList = modelsRes.ok ? (await modelsRes.json()).models ?? [] : [];
        if (!cancelled) {
          setTier(settings.userSubscriptionTier ?? 'free');
          setSelected(settings.imageGenerationModel ?? null);
          setModels(modelList);
        }
      } catch {
        if (!cancelled) toast.error('Failed to load image-generation settings');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const allowed = isImageGenerationAllowedForTier(tier);

  async function onChange(value: string) {
    const next = value === NONE ? null : value;
    const previous = selected;
    setSelected(next);
    setSaving(true);
    try {
      await patch('/api/ai/settings/image-model', { imageGenerationModel: next });
      toast.success(next ? 'Image model updated' : 'Image generation model cleared');
    } catch {
      setSelected(previous);
      toast.error('Failed to update image model');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ImageIcon className="h-5 w-5" />
          Image generation
        </CardTitle>
        <CardDescription>
          Choose the model the AI uses when it generates images. This is a tool the assistant can call —
          it does not change your chat model. Generated images are saved to your Home drive.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !allowed ? (
          <div className="flex items-center justify-between rounded-md border p-3 max-w-md">
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Lock className="h-4 w-4" />
              Image generation is available on paid plans.
            </span>
            <Button size="sm" onClick={() => router.push('/settings/plan')}>Upgrade</Button>
          </div>
        ) : (
          <div className="max-w-md space-y-2">
            <Select value={selected ?? NONE} onValueChange={onChange} disabled={saving}>
              <SelectTrigger>
                <SelectValue placeholder="Select an image model" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>None (use default)</SelectItem>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>{m.displayName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {saving && (
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Saving…
              </p>
            )}
            {models.length === 0 && (
              <p className="text-xs text-muted-foreground">No image models are currently available.</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
