'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import {
  User,
  Pencil,
  BookOpen,
  Loader2,
  ArrowLeft,
  Info,
  ExternalLink,
  FolderOpen,
} from 'lucide-react';
import { patch, fetchWithAuth } from '@/lib/auth/auth-fetch';

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

type MemoryField = 'bio' | 'writingStyle' | 'rules';

interface MemoryPageSummary {
  field: MemoryField;
  title: string;
  pageId: string | null;
  href: string | null;
  preview: string;
  isEmpty: boolean;
}

interface PersonalizationData {
  enabled: boolean;
  memoryFolderHref: string | null;
  pages: MemoryPageSummary[];
}

const FIELD_META: Record<MemoryField, { icon: typeof User; description: string }> = {
  bio: {
    icon: User,
    description: 'Your background, expertise, and how you think about problems.',
  },
  writingStyle: {
    icon: Pencil,
    description: 'How the AI should write — both replying to you and drafting as you.',
  },
  rules: {
    icon: BookOpen,
    description: 'Instructions the AI should follow in every workspace.',
  },
};

export default function PersonalizationSettingsPage() {
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();

  const { data, mutate, isLoading } = useSWR<{ personalization: PersonalizationData }>(
    user ? '/api/settings/personalization' : null,
    fetcher
  );

  const [enabled, setEnabled] = useState(true);
  const [isTogglePending, setIsTogglePending] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/auth/signin');
    }
  }, [authLoading, user, router]);

  useEffect(() => {
    if (data?.personalization) {
      setEnabled(data.personalization.enabled);
    }
  }, [data]);

  /**
   * Only one PATCH is ever in flight.
   *
   * Without this, rapid toggling starts overlapping writes and the responses
   * can settle out of order, leaving the server on the OLDER value while the
   * switch shows the newer one — a silent disagreement about whether the
   * profile is being injected at all.
   */
  const handleToggleEnabled = async (next: boolean) => {
    if (isTogglePending) return;

    const previous = enabled;
    setEnabled(next);
    setIsTogglePending(true);

    try {
      await patch('/api/settings/personalization', { enabled: next });
      toast.success(next ? 'AI personalization enabled' : 'AI personalization disabled');
      mutate();
    } catch (error) {
      setEnabled(previous);
      toast.error('Failed to update personalization setting');
      console.error('Error updating personalization:', error);
    } finally {
      setIsTogglePending(false);
    }
  };

  if (authLoading || isLoading) {
    return (
      <div className="container max-w-4xl mx-auto py-10 px-10 flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const personalization = data?.personalization;
  const pages = personalization?.pages ?? [];

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
          What the AI knows about you lives as pages in the Memory folder of your Home drive. Edit
          them like any other page — the AI reads whatever is there.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>AI Personalization</CardTitle>
              <CardDescription>
                When enabled, your memory pages are included in AI system prompts.
              </CardDescription>
            </div>
            <Switch
              id="personalization-enabled"
              checked={enabled}
              disabled={isTogglePending}
              onCheckedChange={handleToggleEnabled}
            />
          </div>
        </CardHeader>
      </Card>

      {personalization?.memoryFolderHref && (
        <Button
          variant="outline"
          onClick={() => router.push(personalization.memoryFolderHref!)}
          className="w-full justify-start"
        >
          <FolderOpen className="h-4 w-4 mr-2" />
          Open Memory folder
        </Button>
      )}

      <div className={enabled ? 'space-y-4' : 'space-y-4 opacity-60'}>
        {pages.map((page) => {
          const Icon = FIELD_META[page.field].icon;

          return (
            <Card key={page.field}>
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Icon className="h-5 w-5" />
                      {page.title}
                    </CardTitle>
                    <CardDescription>{FIELD_META[page.field].description}</CardDescription>
                  </div>
                  {page.href && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => router.push(page.href!)}
                    >
                      <ExternalLink className="h-4 w-4 mr-2" />
                      Edit page
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {page.isEmpty ? (
                  <p className="text-sm text-muted-foreground italic">
                    {page.href
                      ? 'Nothing here yet. Open the page to write something, or let the AI fill it in as it learns.'
                      : 'This page has not been created yet.'}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap line-clamp-4">
                    {page.preview}
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
          <strong>Privacy Note:</strong> Your personalization data is included in AI prompts to
          customize responses. When using cloud AI providers, this data is sent to those services
          according to their privacy policies.
        </AlertDescription>
      </Alert>
    </div>
  );
}
