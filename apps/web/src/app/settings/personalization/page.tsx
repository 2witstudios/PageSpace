'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { User, Pencil, BookOpen, Loader2, ArrowLeft, Info, Save } from 'lucide-react';
import { patch, fetchWithAuth } from '@/lib/auth/auth-fetch';

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

interface PersonalizationData {
  bio: string;
  writingStyle: string;
  rules: string;
  enabled: boolean;
}

export default function PersonalizationSettingsPage() {
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();

  const { data, mutate, isLoading } = useSWR<{ personalization: PersonalizationData }>(
    user ? '/api/settings/personalization' : null,
    fetcher
  );

  const [formState, setFormState] = useState<PersonalizationData>({
    bio: '',
    writingStyle: '',
    rules: '',
    enabled: true,
  });
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Redirect if not authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/auth/signin');
    }
  }, [authLoading, user, router]);

  // Initialize form state from server data
  useEffect(() => {
    if (data?.personalization) {
      setFormState(data.personalization);
      setIsDirty(false);
    }
  }, [data]);

  const handleFieldChange = (field: keyof PersonalizationData, value: string | boolean) => {
    setFormState((prev) => ({ ...prev, [field]: value }));
    setIsDirty(true);
  };

  const handleToggleEnabled = async (enabled: boolean) => {
    // Update locally immediately
    setFormState((prev) => ({ ...prev, enabled }));

    try {
      await patch('/api/settings/personalization', { enabled });
      toast.success(enabled ? 'AI personalization enabled' : 'AI personalization disabled');
      // Update SWR cache optimistically without revalidating to preserve unsaved form edits
      mutate(
        (current) =>
          current ? { personalization: { ...current.personalization, enabled } } : current,
        { revalidate: false }
      );
    } catch (error) {
      // Revert on error
      setFormState((prev) => ({ ...prev, enabled: !enabled }));
      toast.error('Failed to update personalization setting');
      console.error('Error updating personalization:', error);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await patch('/api/settings/personalization', {
        bio: formState.bio,
        writingStyle: formState.writingStyle,
        rules: formState.rules,
      });
      toast.success('Personalization settings saved');
      setIsDirty(false);
      mutate();
    } catch (error) {
      toast.error('Failed to save personalization settings');
      console.error('Error saving personalization:', error);
    } finally {
      setIsSaving(false);
    }
  };

  if (authLoading || isLoading) {
    return (
      <div className="container max-w-4xl mx-auto py-10 px-10 flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="container max-w-4xl mx-auto py-10 px-10 space-y-8">
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
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <User className="h-8 w-8" />
          Personalization
        </h1>
        <p className="text-muted-foreground mt-2">
          Customize how PageSpace AI interacts with you. This information will be included in AI conversations to provide more relevant responses.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>AI Personalization</CardTitle>
              <CardDescription>
                When enabled, your personalization settings will be included in AI system prompts.
              </CardDescription>
            </div>
            <Switch
              id="personalization-enabled"
              checked={formState.enabled}
              onCheckedChange={handleToggleEnabled}
            />
          </div>
        </CardHeader>
      </Card>

      <Card className={!formState.enabled ? 'opacity-60' : ''}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            About You
          </CardTitle>
          <CardDescription>
            Tell the AI about yourself - your role, expertise, and background.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea
            id="bio"
            placeholder="e.g., I'm a software engineer specializing in React and TypeScript. I work on a B2B SaaS product and often need help with complex state management and API design..."
            value={formState.bio}
            onChange={(e) => handleFieldChange('bio', e.target.value)}
            disabled={!formState.enabled}
            className="min-h-[120px] resize-y"
          />
        </CardContent>
      </Card>

      <Card className={!formState.enabled ? 'opacity-60' : ''}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Pencil className="h-5 w-5" />
            Writing Style
          </CardTitle>
          <CardDescription>
            Describe how you&apos;d like the AI to communicate with you.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea
            id="writingStyle"
            placeholder="e.g., Be concise and direct. Use bullet points for lists. Provide code examples when explaining technical concepts. Avoid overly formal language..."
            value={formState.writingStyle}
            onChange={(e) => handleFieldChange('writingStyle', e.target.value)}
            disabled={!formState.enabled}
            className="min-h-[120px] resize-y"
          />
        </CardContent>
      </Card>

      <Card className={!formState.enabled ? 'opacity-60' : ''}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="h-5 w-5" />
            Custom Rules
          </CardTitle>
          <CardDescription>
            Add any specific instructions or rules for the AI to follow.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea
            id="rules"
            placeholder="e.g., Always suggest TypeScript solutions over JavaScript. When writing code, include error handling. Prefer functional programming patterns..."
            value={formState.rules}
            onChange={(e) => handleFieldChange('rules', e.target.value)}
            disabled={!formState.enabled}
            className="min-h-[120px] resize-y"
          />
        </CardContent>
      </Card>

      <div className="flex justify-end gap-4">
        <Button
          onClick={handleSave}
          disabled={!isDirty || isSaving || !formState.enabled}
        >
          {isSaving ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Save className="h-4 w-4 mr-2" />
              Save Changes
            </>
          )}
        </Button>
      </div>

      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
          <strong>Privacy Note:</strong> Your personalization data is only used to customize AI responses within PageSpace. It is not shared with third parties or used for any other purpose.
        </AlertDescription>
      </Alert>
    </div>
  );
}
