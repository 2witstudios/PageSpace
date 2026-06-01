'use client';

import { useCallback, useState } from 'react';
import { useSWRConfig } from 'swr';
import { toast } from 'sonner';
import { FileText, ListTodo, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Suggestions, Suggestion } from '@/components/ai/ui/suggestion';
import { usePageNavigation } from '@/hooks/usePageNavigation';
import { useDisplayPreferences } from '@/hooks/useDisplayPreferences';
import { post } from '@/lib/auth/auth-fetch';
import { PageType, getDefaultContent, getPageTypeConfig } from '@pagespace/lib/client-safe';
import type { Page } from '@pagespace/lib/client-safe';

// Prompts that send immediately — they're self-contained questions.
const SEND_PROMPTS = [
  'Summarize what changed in this drive recently',
  'What should I work on next here?',
];

// Open-ended prompts — populate the input so the user can finish the thought.
const DRAFT_PROMPTS = ['Find a page about…', 'Draft a new doc about…'];

interface AskOrDoProps {
  driveId: string;
  /** Send a prompt to the assistant immediately */
  onPromptSelect: (prompt: string) => void;
  /** Place a prompt into the input for the user to complete */
  onPromptDraft: (prompt: string) => void;
  /** Open the full quick-create palette */
  onQuickCreate: () => void;
}

/**
 * "Ask / do" — drive-aware prompt starters that feed the chat input, plus
 * quick-create actions. Always shown; this is the action surface of Drive Home.
 */
export function AskOrDo({ driveId, onPromptSelect, onPromptDraft, onQuickCreate }: AskOrDoProps) {
  const { navigateToPage } = usePageNavigation();
  const { preferences } = useDisplayPreferences();
  const { mutate } = useSWRConfig();
  const [creating, setCreating] = useState<PageType | null>(null);

  const createPage = useCallback(
    async (type: PageType) => {
      if (creating) return;
      setCreating(type);
      let page: Page;
      try {
        // Mirror QuickCreatePalette: respect the user's default-Markdown
        // preference for documents so the doc opens in the expected editor.
        const contentMode =
          type === PageType.DOCUMENT && preferences.defaultMarkdownMode ? 'markdown' : undefined;
        page = await post<Page>('/api/pages', {
          title: `Untitled ${getPageTypeConfig(type).displayName}`,
          type,
          driveId,
          parentId: null,
          content: getDefaultContent(type),
          ...(contentMode && { contentMode }),
        });
        await mutate(`/api/drives/${driveId}/pages`);
      } catch (error) {
        toast.error((error as Error).message ?? 'Failed to create page');
        return;
      } finally {
        setCreating(null);
      }
      // Navigate outside the guarded block so a navigation hiccup isn't
      // surfaced as a "failed to create" error — the page already exists.
      await navigateToPage(page.id, driveId);
    },
    [creating, driveId, preferences.defaultMarkdownMode, mutate, navigateToPage]
  );

  return (
    <section className="space-y-3">
      <Suggestions>
        {SEND_PROMPTS.map((prompt) => (
          <Suggestion key={prompt} suggestion={prompt} onClick={onPromptSelect} />
        ))}
        {DRAFT_PROMPTS.map((prompt) => (
          <Suggestion key={prompt} suggestion={prompt} onClick={onPromptDraft} />
        ))}
      </Suggestions>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={creating !== null}
          onClick={() => createPage(PageType.DOCUMENT)}
          className="gap-1.5"
        >
          <FileText className="h-4 w-4" />
          New doc
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={creating !== null}
          onClick={() => createPage(PageType.TASK_LIST)}
          className="gap-1.5"
        >
          <ListTodo className="h-4 w-4" />
          New task list
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onQuickCreate}
          className="gap-1.5 text-muted-foreground"
        >
          <Plus className="h-4 w-4" />
          New page…
        </Button>
      </div>
    </section>
  );
}
