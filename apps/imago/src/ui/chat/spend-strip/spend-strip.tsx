'use client';

import { useState, type ReactNode } from 'react';
import { spendRefusalCopy } from '@pagespace/lib/billing/spend-refusal-copy';
import { composerStripModel } from '@pagespace/lib/billing/spend-surface';
import { useConversationSpend, useDriveSpend } from '@/retained/hooks/useConversationSpend';
import { Popover, PopoverContent, PopoverTrigger } from '@/retained/components/ui/popover';
import { SpendSourceOptionsPanel } from '@/retained/components/wallets/SpendSourcePopover';
import { renderIcon } from '../../components/icon/icon.render';

/** The strip above the composer (SPEC v3 "spend strip"). */
export const spendStripClass = 'mx-2 flex min-h-spend-strip flex-none items-center gap-2 px-1 text-xs text-ink-muted';

/**
 * Who pays, above the composer — only when there is a choice or a problem. It shows:
 * (a) several sources to choose from, before the first message (composerStripModel);
 * (b) a refused source, with its refusal copy (and Choose when there is another), or a permitted
 *     fallback with its note, both even mid-thread;
 * (c) a drive context whose source is still resolving or failed to resolve (JOURNEYS-2).
 * Paying from your own credits with nothing to choose shows nothing: the balance lives in the
 * account menu, and running out is OutOfCreditsAlert's to say.
 */
export function SpendStrip({ conversationId = null, driveId = null, isGlobal = false, hasMessages = false, onChooseDraftSource }: {
  readonly conversationId?: string | null;
  readonly driveId?: string | null;
  readonly isGlobal?: boolean;
  /** The conversation already has messages: the source was chosen, so a choice no longer shows. */
  readonly hasMessages?: boolean;
  /** Materialize a new agent conversation with its source atomically, without sending a turn. */
  readonly onChooseDraftSource?: (walletId: string) => Promise<void>;
} = {}): ReactNode {
  const { spend: conversation, error: conversationError, choose, refresh: refreshConversation } = useConversationSpend(conversationId, { driveId, isGlobal });
  const { spend: drive, error: driveError, refresh: refreshDrive } = useDriveSpend(conversationId ? null : driveId);
  const scoped = conversationId !== null || driveId !== null;
  const [open, setOpen] = useState(false);
  const spend = conversationId ? conversation : drive;
  const resolved = spend?.resolved;
  const selected = resolved?.kind === 'spend'
    ? spend?.options.find(option => option.walletId === resolved.walletId) ?? null
    : null;
  const refusedChoice = resolved?.kind === 'refuse' ? spend?.options.find(option => option.source === resolved.source) ?? null : null;
  const refusedCopy = resolved?.kind === 'refuse' ? spendRefusalCopy({ reason: resolved.reason, source: refusedChoice, hasOptions: resolved.options.length > 0, now: new Date() }) : null;
  // A fallback is a problem, not a choice: its note ("X cannot cover this") shows even mid-thread.
  // The same test composerStripModel uses to write the note: applied, and moved off a named source.
  const fallback = resolved?.kind === 'spend' && resolved.fallbackApplied && resolved.fallbackFrom !== null;
  const strip = spend
    ? composerStripModel({ ...spend, hasMessages: hasMessages && !fallback }) ?? (refusedCopy ? { label: refusedChoice?.label ?? null, detail: refusedCopy.body, tone: 'refused' as const } : null)
    : null;
  // JOURNEYS-2: in a drive (multi-source) context an UNRESOLVED source is state the sender
  // must see, not silence — sending pauses (the composer's readiness gate reads the same
  // preview) until the source resolves, and a failed preview offers the retry.
  if (scoped && conversation === null && drive === null) {
    const failed = (conversationId ? conversationError : driveError) !== null && (conversationId ? conversationError : driveError) !== undefined;
    const retry = () => { if (conversationId) void refreshConversation(); else void refreshDrive(); };
    return (
      <div data-testid={failed ? 'composer-spend-strip-error' : 'composer-spend-strip-pending'} className={spendStripClass} role="status" aria-label={failed ? 'Credit source could not be checked' : 'Resolving credit source'}>
        {renderIcon({ name: 'wallet', size: 13 })}
        <span className="min-w-0 flex-1 truncate">
          {failed ? 'Who pays could not be checked — sending is paused until the source is shown.' : 'Resolving who pays…'}
        </span>
        {failed ? <button type="button" data-testid="composer-spend-retry" className="font-medium text-accent-deep hover:underline" onClick={retry}>Retry check</button> : null}
      </div>
    );
  }
  if (strip === null) return null;
  const refused = strip.tone === 'refused';
  const { label, detail } = strip;
  return (
    <div className={spendStripClass} role="status" aria-label={refused ? 'Credit source refused' : 'Spending from'}>
      {renderIcon({ name: 'wallet', size: 13 })}
      <span className="min-w-0 flex-1 truncate">
        {label ? <>{refused ? '' : 'Spending from '}<strong className="font-semibold text-ink">{label}</strong> · </> : null}{detail}
      </span>
      {(conversationId || onChooseDraftSource) && spend && spend.options.length > 1 ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild><button type="button" className="font-medium text-accent-deep hover:underline">{refused ? 'Choose' : 'Change'}</button></PopoverTrigger>
          <PopoverContent align="end" side="top" className="w-agent-picker max-w-full p-0">
            <SpendSourceOptionsPanel options={spend.options} selectedWalletId={selected?.walletId ?? conversation?.chosenWalletId ?? null} driveName={spend.options.find(option => option.driveName)?.driveName ?? null} onChoose={walletId => conversationId ? choose(walletId) : onChooseDraftSource!(walletId)} onDone={() => setOpen(false)} />
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}
