'use client';

/**
 * PaneBar — the universal pane title bar, ported from the machine workspace
 * grid (deleted in the phase-8 teardown) unchanged apart from its one piece of
 * git topology.
 *
 * Every pane wears one slim bar: identity on the left, actions on the right.
 * It replaced BOTH pieces of floating chrome the grid used to carry — the
 * hover-revealed split/close chip, which on chat panes physically covered the
 * chat header's own controls, and the 2px top accent line, since the bar's
 * tint IS the focus state.
 *
 * Actions dim rather than hide (opacity, never display/visibility), so they
 * stay clickable on every pointer type without the coarse-pointer escape hatch
 * an opacity-0 chip needs.
 *
 * Pure presentational by design: no store, no hooks, no network — the caller
 * decides what identity and actions mean, so a terminal pane and a chat pane
 * wear the same bar without either knowing about the other. That is also what
 * lets the agent page's session-less chat wear it with no grid behind it at
 * all: it supplies an identity and one action, and the bar asks no questions.
 *
 * The only thing dropped in the port is the checkout chip (`scopeLabel`), which
 * named a project/branch. That slot is now the agent label, so a grid holding
 * conversations with several different agents says which is which.
 *
 * The shared pieces a bar is BUILT from live here too — the tab strip, the
 * split/close controls, "+", "Open in Agents", the identity — because the AI_CHAT
 * page and the agents console both assemble a bar from them and must not drift
 * into two differently-shaped versions of the same control. That sharing is what
 * let the page drop its own header, which carried a second, full-size copy of
 * the same Chat/History/Settings tabs the host pane's bar already had.
 */

import type { MouseEvent, ReactNode } from 'react';
import Link from 'next/link';
import {
  Check,
  ExternalLink,
  History,
  Loader2,
  MessageSquare,
  Plus,
  Save,
  Settings,
  SquareSplitHorizontal,
  SquareSplitVertical,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AgentSettingsSaveState } from '@/lib/ai/shared/hooks/useAgentSettingsSaveState';
import { Button } from '@/components/ui/button';

export default function PaneBar({
  isActive,
  identity,
  actions,
}: {
  /** The bar tint is the pane's focus indicator — no separate accent line. */
  isActive: boolean;
  /** Left side: who this pane is (bound session, or the picker). */
  identity: ReactNode;
  /** Right side: the pane's controls, dimmed until hover/focus. */
  actions?: ReactNode;
}) {
  return (
    <div
      data-testid="pane-bar"
      data-active={isActive ? 'true' : undefined}
      className={cn(
        'flex h-[30px] min-w-0 shrink-0 items-center gap-1 border-b border-border/60 pl-2 pr-1 transition-colors',
        isActive && 'border-primary/40 bg-primary/10',
      )}
    >
      <div
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1.5 text-xs font-medium',
          isActive ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {identity}
      </div>
      {actions !== undefined && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity focus-within:opacity-100 group-hover/pane:opacity-100 touch:opacity-100">
          {actions}
        </div>
      )}
    </div>
  );
}

/**
 * Swallows the bubble so a control click never re-selects the pane first — the
 * same guard the floating chip's buttons carried.
 */
function guarded(handler: () => void) {
  return (event: MouseEvent) => {
    event.stopPropagation();
    handler();
  };
}

/**
 * The pane-level control handlers every surface shares. Passed as DATA rather
 * than a pre-rendered node so a surface can render them however its bar needs —
 * inline at full width, or folded into an overflow menu when the pane is narrow.
 */
export interface PaneControlProps {
  /** False on narrow viewports — two columns at phone width are unusable slivers. */
  canSplit: boolean;
  /** Close is universal — a view you cannot destroy is not a view. */
  canClose: boolean;
  onSplitRight(): void;
  onSplitDown(): void;
  onClose(): void;
}

/** The shared inline rendering of {@link PaneControlProps}: split right/down + close. */
export function PaneSplitCloseActions({
  canSplit,
  canClose,
  onSplitRight,
  onSplitDown,
  onClose,
}: PaneControlProps) {
  return (
    <>
      {canSplit && (
        <>
          <Button
            variant="ghost"
            size="icon"
            onClick={guarded(onSplitRight)}
            className="size-6 text-muted-foreground hover:text-foreground"
            title="Split right"
            aria-label="Split right"
          >
            <SquareSplitHorizontal className="size-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={guarded(onSplitDown)}
            className="size-6 text-muted-foreground hover:text-foreground"
            title="Split down"
            aria-label="Split down"
          >
            <SquareSplitVertical className="size-3.5" aria-hidden="true" />
          </Button>
        </>
      )}
      {canClose && (
        <Button
          variant="ghost"
          size="icon"
          onClick={guarded(onClose)}
          className="size-6 text-muted-foreground hover:text-destructive"
          title="Close pane"
          aria-label="Close pane"
        >
          <X className="size-3.5" aria-hidden="true" />
        </Button>
      )}
    </>
  );
}

/**
 * "Start a new conversation" — the one action a chat surface offers from its
 * bar whether or not it has a grid to split. Shared rather than inlined so the
 * pane grid and the agent page's plain (session-less) chat cannot drift into
 * two differently-worded, differently-shaped buttons for the same act.
 */
export function PaneNewConversationAction({
  disabled,
  onCreate,
}: {
  disabled: boolean;
  onCreate(): void;
}) {
  return (
    <button
      type="button"
      aria-label="Start a new conversation"
      title="Start a new conversation"
      disabled={disabled}
      onClick={guarded(onCreate)}
      className="flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
    >
      <Plus className="size-3.5" aria-hidden="true" />
    </button>
  );
}

/**
 * The Settings tab's Save, scaled for a 30px bar: clean/dirty/saving/saved as
 * one control, no toast.
 *
 * Shared because BOTH chat surfaces show a Settings tab now — a grid pane and
 * the agent page's session-less chat — and a save button that reports its state
 * differently depending on which bar you are looking at is exactly the drift
 * this file exists to prevent.
 */
export function PaneSettingsSaveAction({
  saveState,
  onSave,
}: {
  saveState: AgentSettingsSaveState;
  onSave(): void;
}) {
  return (
    <button
      type="button"
      onClick={guarded(onSave)}
      // Only clickable once there is something to save — also the guard against
      // clicking before the agent's config has arrived.
      disabled={saveState !== 'dirty'}
      // The state change (Saving.../Saved) is the ONLY save confirmation —
      // there is no toast — so screen readers need this to catch it.
      aria-live="polite"
      aria-atomic="true"
      className={cn(
        'flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors disabled:pointer-events-none',
        saveState === 'clean' && 'text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50',
        saveState === 'dirty' && 'text-warning hover:bg-warning/10',
        saveState === 'saving' && 'text-warning',
        saveState === 'saved' && 'text-success',
      )}
    >
      {saveState === 'saving' ? (
        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
      ) : saveState === 'saved' ? (
        <Check className="size-3 animate-in zoom-in-50 fade-in-0 duration-200" aria-hidden="true" />
      ) : (
        <span className="relative inline-flex">
          <Save className="size-3" aria-hidden="true" />
          {saveState === 'dirty' && (
            <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 size-1 animate-pulse rounded-full bg-warning" />
          )}
        </span>
      )}
      {saveState === 'saved' ? 'Saved' : 'Save'}
    </button>
  );
}

/**
 * "Open in Agents" — the cross-link from a chat pane hosted on an AI_CHAT page
 * to the same conversation in the agents console.
 *
 * It lives in the BAR, not a page header, because the page header is gone: one
 * pane, one bar, one set of controls. Only page-hosted panes render it — inside
 * the console itself it would link to where the user already is.
 */
export function PaneOpenInAgentsAction({ href }: { href: string }) {
  return (
    <Link
      href={href}
      aria-label="Open in Agents"
      title="Open in Agents"
      // The pane's own click handler selects the pane; a navigation should not
      // also re-select on its way out, same as every other control in this bar.
      onClick={(event) => event.stopPropagation()}
      className="flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <ExternalLink className="size-3.5" aria-hidden="true" />
    </Link>
  );
}

/**
 * A pane's identity: a status dot, the session name, and an optional label.
 *
 * The dot's FILL means "a live session is bound here" — in the pane grid that
 * is always true, since it only shows sessions that exist server-side, which is
 * why `bound` defaults to true. The agent page also wears this bar outside any
 * grid, over a conversation that usually has NO session (binding is congenital
 * and permanent, so history is full of them); it passes the conversation's own
 * binding, and a hollow, muted dot is what says so. Same bar, honest state. The
 * label carries the agent name for a chat pane, which is what keeps a grid of
 * conversations with different agents readable.
 */
export function PaneSessionIdentity({
  name,
  label,
  bound = true,
}: {
  name: string;
  label?: string;
  bound?: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span
        aria-hidden
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          bound ? 'bg-emerald-500' : 'border border-muted-foreground/60',
        )}
      />
      {/* The dot itself is decorative, but what it now ENCODES is not: it is
          the only thing distinguishing a workspace-backed conversation from a
          plain one. While it was always-green that cost a screen-reader user
          nothing; now it would cost them the whole signal. */}
      <span className="sr-only">{bound ? 'Workspace session: ' : 'No workspace session: '}</span>
      <span className="truncate font-mono text-[11px]">{name}</span>
      {label !== undefined && (
        <span className="shrink-0 rounded border border-border px-1 py-px text-[10px] font-normal text-muted-foreground">
          {label}
        </span>
      )}
    </span>
  );
}

/** Which of a chat surface's three faces its bar is currently showing. */
export type PaneChatTab = 'chat' | 'history' | 'settings';

/**
 * The tab strip itself — icon-only (a pane bar is 30px tall, no room for
 * spacious text pills), tooltipped/aria-labeled for the text a mouse-hover or
 * screen reader still needs.
 *
 * Lives here rather than in `AgentPanes` because it is not the grid's: the
 * agent page's session-less chat wears the same bar with no grid behind it,
 * and Chat/History/Settings has to be reachable from there too. One strip,
 * both surfaces — the whole point of removing the page's own duplicate tabs.
 */
export function PaneChatTabStrip({
  activeTab,
  onSelectTab,
  showSettings,
  agentTitle,
}: {
  activeTab: PaneChatTab;
  onSelectTab: (tab: PaneChatTab) => void;
  showSettings: boolean;
  agentTitle: string;
}) {
  const tabButton = (tab: PaneChatTab, label: string, Icon: typeof MessageSquare) => (
    <button
      type="button"
      role="tab"
      aria-selected={activeTab === tab}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onSelectTab(tab);
      }}
      className={cn(
        'flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground',
        activeTab === tab && 'bg-primary-soft text-foreground',
      )}
    >
      <Icon className="size-3" aria-hidden="true" />
    </button>
  );

  return (
    <div role="tablist" className="flex shrink-0 items-center gap-0.5">
      {tabButton('chat', 'Chat', MessageSquare)}
      {tabButton('history', 'History', History)}
      {showSettings && tabButton('settings', `${agentTitle} settings`, Settings)}
    </div>
  );
}
