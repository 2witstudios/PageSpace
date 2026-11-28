'use client';

import { useEffect, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/retained/components/ui/select';
import { Loader2, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { fetchWithAuth, patch } from '@/retained/lib/auth/auth-fetch';
import { isImageGenerationAllowed } from '@/retained/lib/ai/core/image-gen-access';
import { SettingsRow } from '@/ui/settings/settings-screen/settings-screen';

interface ImageModel {
  id: string;
  displayName: string;
}

const NONE = '__none__';

/** The image-generation default: a row in the AI defaults group. Only admins may change it. */
export function ImageGenerationSetting() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
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
          setIsAdmin(settings.isAdmin === true);
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

  const allowed = isImageGenerationAllowed(isAdmin);

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
    <SettingsRow label="Image generation" hint="Model Imago uses when you ask for an image.">
      {loading ? (
        <span className="text-sm text-muted-foreground">Loading…</span>
      ) : !allowed ? (
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <Lock className="h-4 w-4" aria-hidden="true" />
          Restricted to app administrators.
        </span>
      ) : (
        <div className="flex items-center gap-2">
          <Select value={selected ?? NONE} onValueChange={onChange} disabled={saving}>
            <SelectTrigger aria-label="Image generation" className="w-56">
              <SelectValue placeholder="Select an image model" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>None (use default)</SelectItem>
              {models.map((m) => (
                <SelectItem key={m.id} value={m.id}>{m.displayName}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-label="Saving" />}
        </div>
      )}
    </SettingsRow>
  );
}
