'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, Save, Brain } from 'lucide-react';
import { useToast } from '@/hooks/useToast';
import { fetchWithAuth, patch } from '@/lib/auth/auth-fetch';

interface DriveAISettingsProps {
  driveId: string;
}

export function DriveAISettings({ driveId }: DriveAISettingsProps) {
  const [driveContext, setDriveContext] = useState('');
  const [originalContext, setOriginalContext] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const hasChanges = driveContext !== originalContext;

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
      await patch(`/api/drives/${driveId}`, { drivePrompt: driveContext });
      setOriginalContext(driveContext);
      toast({
        title: 'Success',
        description: 'Drive context saved successfully',
      });
    } catch (error) {
      console.error('Error saving drive context:', error);
      toast({
        title: 'Error',
        description: 'Failed to save drive context',
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
            <Brain className="w-5 h-5" />
            Drive Context
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
          <Brain className="w-5 h-5" />
          Drive Context
        </CardTitle>
        <CardDescription>
          Workspace memory that persists across AI conversations. The AI can also update this context
          as it learns about your project, similar to how CLAUDE.md works in Claude Code.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Textarea
          value={driveContext}
          onChange={(e) => setDriveContext(e.target.value)}
          placeholder="Add context about this workspace...

Examples:
- Project structure: /docs for documentation, /api-specs for API definitions
- Tech stack: Next.js 15, TypeScript, PostgreSQL
- Conventions: Use PascalCase for components, camelCase for functions
- Preferences: Prefer concise responses, always include code examples"
          className="min-h-[250px] font-mono text-sm"
          maxLength={10000}
        />
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {driveContext.length.toLocaleString()} / 10,000 characters
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
                Save Context
              </>
            )}
          </Button>
        </div>
        <div className="pt-4 border-t">
          <h4 className="text-sm font-medium mb-2">How it works</h4>
          <ul className="text-sm text-muted-foreground space-y-1">
            <li>• This context is included in AI conversations when working in this drive</li>
            <li>• The AI can use the update_drive_context tool to add information it learns</li>
            <li>• AI agents (AI Chat pages) can optionally include this context via their settings</li>
            <li>• Context is visible to all drive members but only editable by owners and admins</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
