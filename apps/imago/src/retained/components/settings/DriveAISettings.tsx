'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/retained/components/ui/button';
import { Label } from '@/retained/components/ui/label';
import { Skeleton } from '@/retained/components/ui/skeleton';
import { Textarea } from '@/retained/components/ui/textarea';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { fetchWithAuth, patch } from '@/retained/lib/auth/auth-fetch';
import { useEditingStore } from '@/retained/stores/useEditingStore';
import { SettingsSection } from '@/ui/settings/settings-screen/settings-screen';

interface DriveAISettingsProps {
  driveId: string;
}

const MAX_CONTEXT_LENGTH = 10000;
/** One id for the whole editor: a dirty context must not be clobbered by a SWR refresh (useEditingStore). */
const EDITING_ID = 'drive-context';

/**
 * The drive context editor (C-Settings-Context): a live "N / 10,000" counter, Revert and Save
 * context (PATCH drivePrompt), and the three-bullet "How it works". The "Last change by" line
 * waits for the attribution API, so it is not drawn.
 */
export function DriveAISettings({ driveId }: DriveAISettingsProps) {
  const [driveContext, setDriveContext] = useState('');
  const [originalContext, setOriginalContext] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const startEditing = useEditingStore((s) => s.startEditing);
  const endEditing = useEditingStore((s) => s.endEditing);

  const hasChanges = driveContext !== originalContext;

  useEffect(() => {
    if (hasChanges) startEditing(EDITING_ID, 'form', { componentName: 'DriveAISettings' });
    else endEditing(EDITING_ID);
  }, [hasChanges, startEditing, endEditing]);

  useEffect(() => {
    return () => endEditing(EDITING_ID);
  }, [endEditing]);

  useEffect(() => {
    const fetchDrive = async () => {
      try {
        const response = await fetchWithAuth(`/api/drives/${driveId}`);
        if (!response.ok) throw new Error('Failed to fetch drive');
        const data = await response.json();
        const context = data.drivePrompt || '';
        setDriveContext(context);
        setOriginalContext(context);
      } catch (error) {
        console.error('Error fetching drive:', error);
        toast.error('Failed to load drive settings');
      } finally {
        setLoading(false);
      }
    };
    fetchDrive();
  }, [driveId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await patch(`/api/drives/${driveId}`, { drivePrompt: driveContext });
      setOriginalContext(driveContext);
      toast.success('Drive context saved successfully');
    } catch (error) {
      console.error('Error saving drive context:', error);
      toast.error('Failed to save drive context');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="drive-context" className="text-sm font-medium">
            Drive context
          </Label>
          <span className="text-xs tabular-nums text-muted-foreground" data-context-counter="">
            {driveContext.length.toLocaleString('en-US')} / {MAX_CONTEXT_LENGTH.toLocaleString('en-US')}
          </span>
        </div>
        <Textarea
          id="drive-context"
          aria-label="Drive context"
          value={driveContext}
          onChange={(e) => setDriveContext(e.target.value)}
          rows={18}
          className="font-mono text-sm"
          maxLength={MAX_CONTEXT_LENGTH}
        />
        <div className="flex items-center justify-between gap-4">
          <span className="text-xs text-muted-foreground">Visible to everyone in the drive · editable by owners and admins</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setDriveContext(originalContext)} disabled={saving || !hasChanges}>
              Revert
            </Button>
            <Button onClick={handleSave} disabled={saving || !hasChanges}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save context
            </Button>
          </div>
        </div>
      </div>

      <SettingsSection title="How it works">
        <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
          <li>Included in AI conversations whenever you work in this drive.</li>
          <li>Imago can add what it learns with Update Context.</li>
          <li>AI Chat pages can opt in to this context from their own settings.</li>
        </ul>
      </SettingsSection>
    </div>
  );
}
