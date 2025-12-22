'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, Save, Bot } from 'lucide-react';
import { useToast } from '@/hooks/useToast';
import { fetchWithAuth, patch } from '@/lib/auth/auth-fetch';

interface DriveAISettingsProps {
  driveId: string;
}

export function DriveAISettings({ driveId }: DriveAISettingsProps) {
  const [drivePrompt, setDrivePrompt] = useState('');
  const [originalPrompt, setOriginalPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const hasChanges = drivePrompt !== originalPrompt;

  useEffect(() => {
    const fetchDrive = async () => {
      try {
        const response = await fetchWithAuth(`/api/drives/${driveId}`);
        if (!response.ok) throw new Error('Failed to fetch drive');
        const data = await response.json();
        const prompt = data.drivePrompt || '';
        setDrivePrompt(prompt);
        setOriginalPrompt(prompt);
      } catch (error) {
        console.error('Error fetching drive:', error);
        toast({
          title: 'Error',
          description: 'Failed to load drive settings',
          variant: 'destructive',
        });
      } finally {
        setLoading(false);
      }
    };
    fetchDrive();
  }, [driveId, toast]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await patch(`/api/drives/${driveId}`, { drivePrompt });
      setOriginalPrompt(drivePrompt);
      toast({
        title: 'Success',
        description: 'AI instructions saved successfully',
      });
    } catch (error) {
      console.error('Error saving drive prompt:', error);
      toast({
        title: 'Error',
        description: 'Failed to save AI instructions',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot className="w-5 h-5" />
            AI Instructions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="w-5 h-5" />
          AI Instructions
        </CardTitle>
        <CardDescription>
          Set custom instructions that will be included in all AI conversations within this drive.
          These instructions help the AI understand your workspace context, navigation structure, and preferred behaviors.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Textarea
          value={drivePrompt}
          onChange={(e) => setDrivePrompt(e.target.value)}
          placeholder="Enter custom AI instructions for this drive...

Examples:
- This is a legal firm workspace. Always be precise about terminology.
- Project documentation is in /docs, API specs in /api-specs.
- When creating new documents, always include a summary section.
- Prefer formal language in all responses."
          className="min-h-[250px] font-mono text-sm"
          maxLength={10000}
        />
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {drivePrompt.length.toLocaleString()} / 10,000 characters
          </p>
          <Button
            onClick={handleSave}
            disabled={saving || !hasChanges}
          >
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="h-4 w-4 mr-2" />
                Save Instructions
              </>
            )}
          </Button>
        </div>
        <div className="pt-4 border-t">
          <h4 className="text-sm font-medium mb-2">How it works</h4>
          <ul className="text-sm text-muted-foreground space-y-1">
            <li>• These instructions are added to the Global Assistant when you&apos;re working in this drive</li>
            <li>• AI agents (AI Chat pages) can optionally include these instructions via their settings</li>
            <li>• Instructions are visible to all drive members but only editable by owners and admins</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
