'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { UIMessage } from 'ai';
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

/** The tools that change `conversations.planPageId` server-side. */
const PLAN_TOOL_NAMES = new Set(['set_plan', 'clear_plan']);

interface MessagePart {
  type?: string;
  toolName?: string;
  state?: string;
  input?: unknown;
}

/**
 * The tool name a part represents, unwrapping `execute_tool`.
 *
 * Unwrapping is not an edge case: `set_plan`/`clear_plan` are not in
 * `CORE_TOOL_NAMES`, and the Global Assistant route always splits its toolset,
 * so on that surface the agent can ONLY reach them as
 * `execute_tool({ tool_name: 'set_plan' })`. Matching the top-level part name
 * alone would make this component's revalidation dead code exactly where the
 * chip is mounted.
 */
function resolveToolName(part: MessagePart): string | undefined {
  const direct =
    part.toolName ?? (part.type?.startsWith('tool-') ? part.type.slice('tool-'.length) : undefined);
  if (direct !== 'execute_tool') return direct;
  const wrapped = (part.input as { tool_name?: unknown } | undefined)?.tool_name;
  return typeof wrapped === 'string' ? wrapped : undefined;
}

/**
 * How many plan-tool calls have COMPLETED in this conversation.
 *
 * This is an invalidation signal only — never the source of truth. The binding
 * still comes from the server on every read, which is what lets the chip survive
 * a reload and a context summary. But the agent can rebind mid-stream via
 * `set_plan`, and without watching for that the chip would keep showing a stale
 * (or absent) plan until SWR happened to revalidate. Counting completed calls
 * gives a value that only ever moves forward, so it works as an SWR dependency
 * without re-fetching on every render.
 */
function useCompletedPlanToolCount(messages: UIMessage[] | undefined): number {
  return useMemo(() => {
    if (!messages) return 0;
    let count = 0;
    for (const message of messages) {
      for (const part of ((message as { parts?: MessagePart[] }).parts ?? [])) {
        const toolName = resolveToolName(part);
        if (!toolName || !PLAN_TOOL_NAMES.has(toolName)) continue;
        if (part.state === 'output-available' || part.state === 'done') count += 1;
      }
    }
    return count;
  }, [messages]);
}

interface PlanChipProps {
  conversationId?: string | null;
  /**
   * Used ONLY to notice that a plan tool finished, so the persisted binding can
   * be re-fetched. The chip never derives its contents from these.
   */
  messages?: UIMessage[];
}

interface ActivePlanResponse {
  plan: { pageId: string; title: string; driveId: string } | null;
}

export function PlanChip({ conversationId, messages }: PlanChipProps) {
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

  const completedPlanToolCalls = useCompletedPlanToolCount(messages);
  const seenPlanToolCalls = useRef<number | null>(null);
  useEffect(() => {
    const previous = seenPlanToolCalls.current;
    seenPlanToolCalls.current = completedPlanToolCalls;
    // Only a NEW completion needs a re-read. The first observation is skipped
    // because SWR's own initial fetch already covers opening a conversation
    // whose history happens to contain earlier plan-tool calls — reacting to it
    // would just double-fetch on every mount.
    if (previous !== null && completedPlanToolCalls > previous) void mutate();
  }, [completedPlanToolCalls, mutate]);

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
