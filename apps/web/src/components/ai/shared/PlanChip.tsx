'use client';

import React, { useState } from 'react';
import useSWR from 'swr';
import { ClipboardList, ExternalLink, X } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { fetchWithAuth, del } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';

/**
 * The plan this conversation is bound to.
 *
 * Deliberately reads the PERSISTED binding (`conversations.planPageId`) rather
 * than deriving it from the message stream the way TasksDropdown derives its
 * task list. That is the whole point of the binding: a message-derived pointer
 * disappears when its tool call is summarized or scrolls out of the window,
 * which is exactly when a long-running plan is most useful. This chip survives a
 * reload and a context compaction because the server holds the state.
 *
 * Intentionally thin — no inline editing. The plan page is the artifact; this is
 * a pointer to it.
 */

interface PlanChipProps {
  conversationId?: string | null;
}

interface ActivePlanResponse {
  plan: { pageId: string; title: string; driveId: string } | null;
}

export function PlanChip({ conversationId }: PlanChipProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  const { data, mutate } = useSWR<ActivePlanResponse>(
    conversationId ? `/api/ai/conversations/${conversationId}/plan` : null,
    async (url: string) => {
      const response = await fetchWithAuth(url);
      if (!response.ok) throw new Error(`Failed to load plan: ${response.status}`);
      return response.json();
    },
  );

  const plan = data?.plan ?? null;

  const handleClear = async () => {
    if (!conversationId) return;
    setIsClearing(true);
    try {
      await del(`/api/ai/conversations/${conversationId}/plan`);
      await mutate({ plan: null }, { revalidate: false });
      setIsOpen(false);
    } catch {
      toast.error('Failed to clear the plan');
    } finally {
      setIsClearing(false);
    }
  };

  // A conversation that never planned renders nothing at all.
  if (!plan) return null;

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative h-8 w-8" title="Active plan">
          <ClipboardList className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <div className="flex flex-col">
          <div className="px-3 py-2 border-b">
            <p className="text-xs font-medium text-muted-foreground">Active plan</p>
            <p className="text-sm font-medium truncate" title={plan.title}>
              {plan.title}
            </p>
          </div>
          <div className="p-2 flex flex-col gap-1">
            <Link
              href={`/dashboard/${plan.driveId}/${plan.pageId}`}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
              onClick={() => setIsOpen(false)}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open plan
            </Link>
            <button
              type="button"
              onClick={handleClear}
              disabled={isClearing}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" />
              {isClearing ? 'Clearing…' : 'Unbind from this chat'}
            </button>
          </div>
          <p className="px-3 pb-2 text-[11px] text-muted-foreground">
            The page stays; only the link to this conversation is removed.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
