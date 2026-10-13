'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/retained/hooks/useAuth';
import { useRouter } from '@/retained-adapters/navigation';
import useSWR from 'swr';
import { Switch } from '@/retained/components/ui/switch';
import { Button } from '@/retained/components/ui/button';
import { toast } from 'sonner';
import { User, Pencil, BookOpen, Loader2 } from 'lucide-react';
import { patch, fetchWithAuth } from '@/retained/lib/auth/auth-fetch';
import {
  SettingsGroup,
  SettingsRow,
  SettingsScreen,
  SettingsSection,
} from '@/ui/settings/settings-screen/settings-screen';

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
  const memoryFolderHref = personalization?.memoryFolderHref ?? null;

  return (
    <SettingsScreen
      title="Personalization"
      lede="Three pages Imago reads before every conversation, in every drive. Edit them like any page."
    >
      <SettingsSection title="AI personalization">
        <SettingsGroup>
          <SettingsRow
            label="Use in AI"
            hint="Included in AI prompts to tailor replies. Only you can see it."
          >
            <Switch
              id="personalization-enabled"
              aria-label="Use personalization in AI"
              checked={enabled}
              // Belt and braces with the early return in the handler: this makes
              // the control visibly inert while a write is in flight, and the
              // handler guard is what actually holds if a change still lands.
              disabled={isTogglePending}
              onCheckedChange={handleToggleEnabled}
            />
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Memory pages">
        <div className={enabled ? 'flex flex-col gap-3' : 'flex flex-col gap-3 opacity-60'}>
          <SettingsGroup>
            {pages.map((page) => {
              const Icon = FIELD_META[page.field].icon;

              return (
                <SettingsRow
                  key={page.field}
                  label={
                    <span className="flex items-center gap-2">
                      <Icon className="h-4 w-4" aria-hidden="true" />
                      {page.title}
                      {page.isEmpty && (
                        <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                          Empty
                        </span>
                      )}
                    </span>
                  }
                  hint={
                    <span className="flex flex-col gap-1">
                      <span>{FIELD_META[page.field].description}</span>
                      <span className="whitespace-pre-wrap line-clamp-2 italic">
                        {page.isEmpty
                          ? page.href
                            ? 'Nothing here yet. Open the page to write something, or let the AI fill it in as it learns.'
                            : 'This page has not been created yet.'
                          : page.preview}
                      </span>
                    </span>
                  }
                >
                  {page.href && (
                    <Button variant="ghost" size="sm" onClick={() => router.push(page.href!)}>
                      {page.isEmpty ? 'Write' : 'Edit'}
                    </Button>
                  )}
                </SettingsRow>
              );
            })}
          </SettingsGroup>
          <p className="text-xs text-muted-foreground">
            Stored as pages in{' '}
            {memoryFolderHref ? (
              <a
                href={memoryFolderHref}
                className="text-primary hover:underline"
                onClick={(event) => {
                  event.preventDefault();
                  router.push(memoryFolderHref);
                }}
              >
                Home › Memory
              </a>
            ) : (
              'Home › Memory'
            )}
          </p>
        </div>
      </SettingsSection>
    </SettingsScreen>
  );
}
