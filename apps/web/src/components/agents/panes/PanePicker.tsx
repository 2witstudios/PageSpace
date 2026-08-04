'use client';

/**
 * What an unbound pane shows: pick an agent conversation, or a shell.
 *
 * The old machine grid's picker offered the two AGENT TYPES of one machine —
 * `pagespace` (Agent) or `shell`. This one offers a choice the old surface
 * could not: WHICH AGENT the conversation belongs to, so a single grid can hold
 * conversations with several different agents side by side.
 *
 * Presentational, like `PaneBar`: it renders choices and reports them. Minting
 * a conversation or a shell is IO and belongs to the container, which is also
 * the only thing that knows whether a pick should reuse an existing row.
 */

import { useEffect, useRef, useState, type Ref } from 'react';
import { Bot, Search, TerminalSquare } from 'lucide-react';
import useSWR from 'swr';
import { PageType } from '@pagespace/lib/utils/enums';
import { isPaneablePageType } from '@pagespace/lib/content/page-types.config';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { PageTypeIcon } from '@/components/common/PageTypeIcon';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useDebounce } from '@/hooks/useDebounce';

/** The picker needs a label and an id — never the whole agent record. */
export interface PickableAgent {
  id: string;
  title: string;
  /**
   * Set only for a cross-drive list (a global-assistant session's picker
   * spans every accessible drive) — page titles aren't unique, so two drives
   * can hold identically-titled agents that would otherwise be
   * indistinguishable in the list.
   */
  driveName?: string;
}

/** A shell already open in this session but not currently shown in any pane. */
export interface ReattachableShell {
  shellId: string;
  name: string;
}

/** One `/api/mentions/search` result — the shape both `PagePickerPopover` and `TriggerPagePicker` already fetch. */
interface PageSearchResult {
  id: string;
  label: string;
  type: 'page' | 'user';
  description?: string;
  data?: { pageType?: PageType };
}

async function searchPagesFetcher(url: string): Promise<PageSearchResult[]> {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error('Failed to search pages');
  const json: unknown = await response.json();
  return Array.isArray(json) ? (json as PageSearchResult[]) : [];
}

/**
 * The same exclusion `isPaneablePageType` applies, sent to `/api/mentions/search`
 * as `excludePageTypes` so the endpoint drops these BEFORE its own 10-result
 * cap, not after — see the `searchKey` comment in `PagesSection`.
 */
const PANE_UNSUPPORTED_TYPES_PARAM = `${PageType.FOLDER},${PageType.AI_CHAT}`;

export interface PanePickerProps {
  agents: readonly PickableAgent[];
  /** This session's drive, to scope the Pages search — cross-drive when null (a global-assistant session). */
  driveId?: string | null;
  /** No agents resolved yet — distinct from "this drive has none". */
  isLoading?: boolean;
  /**
   * Whether this session's PAYER is on a tier that includes the sandbox
   * (real cloud compute). Chat/panes/pages stay open regardless — only this
   * one affordance is tier-gated. Disabled rather than hidden (a control
   * that should exist must not silently vanish), with an upgrade tooltip.
   */
  canRunSandbox: boolean;
  /**
   * Shells this session already has running, not bound to any pane right
   * now — offered above "Shell" so reopening one is a click rather than a
   * dead end (issue #2263, finding 3: closing a terminal pane used to have
   * no way back to it short of the sidebar's stale count).
   */
  existingShells?: readonly ReattachableShell[];
  /**
   * Takes focus on mount. A split sets this on the pane it just made, so the
   * user lands in the picker rather than a blank rectangle with a control to go
   * hunt for.
   */
  autoFocus?: boolean;
  /**
   * Whether the global assistant is offerable. The identity path exists
   * (`AssistantSessionChat` rides the global chat pipeline), so the one
   * production caller passes true; the flag remains so a host without that
   * renderer can withhold the choice rather than offer a pick with no
   * supplier.
   */
  canPickAssistant?: boolean;
  /** `null` starts a global-assistant conversation, which has no agent page. */
  onPickAgent(agentPageId: string | null): void;
  onPickShell(): void;
  /** Bind this pane to an already-running shell instead of spawning a new one. */
  onReattachShell?(shellId: string, name: string): void;
  /** Bind this pane to a page — `title` is a display label, never an address. */
  onPickPage?(pageId: string, title: string): void;
}

export default function PanePicker({
  agents,
  driveId = null,
  isLoading = false,
  canRunSandbox,
  autoFocus = false,
  canPickAssistant = false,
  existingShells = [],
  onPickAgent,
  onPickShell,
  onReattachShell,
  onPickPage,
}: PanePickerProps) {
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (autoFocus) firstRef.current?.focus();
  }, [autoFocus]);

  return (
    <div
      data-testid="pane-picker"
      className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-4 text-sm"
    >
      <p className="shrink-0 text-xs font-medium text-muted-foreground">Open in this pane</p>

      {/* `shrink-0`, not `min-h-0`: none of this picker's sub-lists scroll on
          their own (the root `overflow-auto` above is the only scroll
          region), so a sub-list must never be allowed to shrink below its
          buttons' height — `min-h-0` on a non-scrolling flex item just lets
          the outer column crush it under space pressure while its buttons
          (already `shrink-0` via the Button component) refuse to shrink,
          which pushes their overflow into the next section instead of
          scrolling — exactly what made a short split pane's "Global
          Assistant" button visually collide with "Agents" and eat its
          clicks. */}
      <div className="flex shrink-0 flex-col gap-1">
        <ShellPickButton
          ref={canRunSandbox ? firstRef : undefined}
          label="Shell"
          disabled={!canRunSandbox}
          onClick={onPickShell}
          testId="pick-shell"
        />

        {canPickAssistant && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 justify-start gap-2 px-2"
            onClick={() => onPickAgent(null)}
            data-testid="pick-global-assistant"
          >
            <Bot className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            Global Assistant
          </Button>
        )}
      </div>

      {/* Shells this session already has, not shown anywhere right now — above
          the drive's agents since reattaching an existing thing outranks
          spawning a new one. */}
      {existingShells.length > 0 && (
        <div className="flex shrink-0 flex-col gap-1">
          <p className="shrink-0 pt-1 text-xs font-medium text-muted-foreground">Reattach a shell</p>
          {existingShells.map((shell) => (
            <ShellPickButton
              key={shell.shellId}
              label={shell.name}
              disabled={!canRunSandbox}
              onClick={() => onReattachShell?.(shell.shellId, shell.name)}
              testId={`reattach-shell-${shell.shellId}`}
            />
          ))}
        </div>
      )}

      {/* The agents of this drive. Listed BELOW the two fixed choices rather than
          merged with them: this list is unbounded, and a drive with forty agents
          must not push "Shell" off the top of a short pane. */}
      {isLoading ? (
        <p data-testid="pane-picker-loading" className="text-xs text-muted-foreground">
          Loading agents…
        </p>
      ) : agents.length > 0 ? (
        <div className="flex shrink-0 flex-col gap-1">
          <p className="shrink-0 pt-1 text-xs font-medium text-muted-foreground">Agents</p>
          {agents.map((agent) => (
            <Button
              key={agent.id}
              variant="ghost"
              size="sm"
              className="h-8 justify-start gap-2 px-2"
              onClick={() => onPickAgent(agent.id)}
              data-testid={`pick-agent-${agent.id}`}
            >
              <Bot className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate">{agent.title}</span>
              {agent.driveName && (
                <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">{agent.driveName}</span>
              )}
            </Button>
          ))}
        </div>
      ) : null}

      {/* Search-as-you-type rather than a bounded list like Agents/Shells —
          a drive can hold far more pages than agents, so there is no fixed
          set to enumerate up front. */}
      {onPickPage && <PagesSection driveId={driveId} onPickPage={onPickPage} />}
    </div>
  );
}

/**
 * One "Shell"/reattach button. Disabled (not hidden) when the session's
 * payer isn't sandbox-eligible — wrapped in a focusable, hoverable `span`
 * rather than relying on the disabled `<button>` itself: a disabled native
 * button gets `pointer-events: none`, which would make the tooltip
 * unreachable by mouse (and the wrapping span keeps it reachable by
 * keyboard too, since Radix's tooltip triggers on focus as well as hover).
 */
function ShellPickButton({
  ref,
  label,
  disabled,
  onClick,
  testId,
}: {
  ref?: Ref<HTMLButtonElement>;
  label: string;
  disabled: boolean;
  onClick: () => void;
  testId: string;
}) {
  const button = (
    <Button
      ref={ref}
      variant="ghost"
      size="sm"
      disabled={disabled}
      className="h-8 w-full justify-start gap-2 px-2"
      onClick={onClick}
      data-testid={testId}
    >
      <TerminalSquare className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </Button>
  );

  if (!disabled) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="cursor-not-allowed">
          {button}
        </span>
      </TooltipTrigger>
      {/* Capability-neutral: `canRunSandbox` folds several denial causes
          (payer tier, the requester's drive role, the deployment kill
          switch) into one boolean, and "upgrade to Pro" is wrong advice for
          all but the tier case (codex round 9). */}
      <TooltipContent>Sandbox terminals aren&apos;t available in this session — they need a Pro-plan workspace with edit access</TooltipContent>
    </Tooltip>
  );
}

/**
 * The "Pages" section: debounced search against the same `/api/mentions/search`
 * endpoint `PagePickerPopover`/`TriggerPagePicker` already use, filtered to
 * pane-safe types (`isPaneablePageType` — no FOLDER, no AI_CHAT). Its own
 * component (rather than inline) so its `useSWR`/`useState` hooks stay
 * independent of `PanePicker`'s own render.
 */
function PagesSection({
  driveId,
  onPickPage,
}: {
  driveId: string | null;
  onPickPage(pageId: string, title: string): void;
}) {
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query, 200);

  // Excluded SERVER-SIDE, not just client-side: the endpoint caps its
  // response to 10 suggestions before this component ever sees them, so
  // filtering only after the fetch can silently shrink (even empty) the
  // visible list whenever the top 10 by relevance/recency happen to include
  // FOLDER/AI_CHAT pages, hiding eligible pages ranked just below them.
  const excludeParam = `&excludePageTypes=${PANE_UNSUPPORTED_TYPES_PARAM}`;
  const searchKey = driveId
    ? `/api/mentions/search?q=${encodeURIComponent(debouncedQuery)}&driveId=${encodeURIComponent(driveId)}&types=page${excludeParam}`
    : `/api/mentions/search?q=${encodeURIComponent(debouncedQuery)}&crossDrive=true&types=page${excludeParam}`;
  // `isValidating`, not `isLoading`: with `keepPreviousData: true`, `isLoading`
  // is false for every key after the first once ANY data has loaded (SWR
  // shows the previous results while revalidating) — retyping after the
  // first search would otherwise show stale results with no "Searching…"
  // signal while the new request is in flight.
  const { data: results = [], isValidating: searching } = useSWR(searchKey, searchPagesFetcher, {
    revalidateOnFocus: false,
    keepPreviousData: true,
  });

  const pages = results.filter(
    (result) => result.type === 'page' && isPaneablePageType(result.data?.pageType ?? PageType.DOCUMENT),
  );

  return (
    <div className="flex shrink-0 flex-col gap-1">
      <p className="shrink-0 pt-1 text-xs font-medium text-muted-foreground">Pages</p>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search pages…"
          className="h-8 pl-7 text-sm"
          data-testid="pane-picker-page-search"
        />
      </div>
      {searching && query !== debouncedQuery ? (
        <p className="px-2 text-xs text-muted-foreground">Searching…</p>
      ) : pages.length === 0 ? (
        // An empty query still fetches (the endpoint answers with the
        // drive's most recently updated pages), so an empty result here
        // means genuinely none — never "haven't typed yet".
        <p className="px-2 text-xs text-muted-foreground">No pages found.</p>
      ) : (
        pages.map((page) => (
          <Button
            key={page.id}
            variant="ghost"
            size="sm"
            className="h-8 justify-start gap-2 px-2"
            onClick={() => onPickPage(page.id, page.label)}
            data-testid={`pick-page-${page.id}`}
          >
            <PageTypeIcon
              type={page.data?.pageType ?? PageType.DOCUMENT}
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <span className="truncate">{page.label}</span>
          </Button>
        ))
      )}
    </div>
  );
}
