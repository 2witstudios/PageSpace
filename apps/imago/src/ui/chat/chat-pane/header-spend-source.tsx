'use client';

import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { spendChipModel } from '@pagespace/lib/billing/spend-surface';
import { useConversationSpend, useDriveSpend } from '@/retained/hooks/useConversationSpend';
import { SpendSourcePopover } from '@/retained/components/wallets/SpendSourcePopover';
import { useSpendContextStore, type SpendContext } from '@/retained/stores/useSpendContextStore';
import { useRetainedChatSelection } from '@/retained-adapters/session-selection';
import { RetainedSurface } from '@/retained-adapters/retained-provider';

/** The focused session is authoritative; a native draft previews its agent's actual drive. */
export function HeaderSpendSource({ agentId, conversationId }: { agentId: string | null; conversationId: string | null }) {
  const active = useSpendContextStore(state => state.active);
  const entries = useSpendContextStore(state => state.entries);
  const selection = useRetainedChatSelection(state => state.selection);
  const { data: agent } = useSWR<{ driveId: string }>(!active && !selection && agentId ? `/api/pages/${encodeURIComponent(agentId)}` : null);
  const fallback = selection ? { conversationId: selection.conversationId, driveId: selection.driveId, isGlobal: selection.agentId === null } : agent ? { conversationId, driveId: agent.driveId, isGlobal: false } : null;
  const [pinned, setPinned] = useState<SpendContext | null>(null);
  const [open, setOpen] = useState(false);
  const target = pinned ?? active ?? fallback;
  const { spend: conversation, isPending, choose } = useConversationSpend(target?.conversationId ?? null, { driveId: target?.driveId ?? null, isGlobal: target?.isGlobal ?? false });
  const preview = !target?.conversationId || (isPending && !conversation);
  const { spend: drive } = useDriveSpend(preview ? target?.driveId ?? null : null);
  const spend = preview ? drive : conversation;
  const resolved = spend?.resolved;
  const selected = resolved?.kind === 'spend' ? spend?.options.find(option => option.walletId === resolved.walletId) ?? null : null;
  const chip = spend ? spendChipModel(spend) ?? (selected ? { source: selected.source, text: selected.remainingCredits === null ? 'No cap' : `${selected.remainingCredits} credits`, tone: 'normal' as const, ariaLabel: `Spending from ${selected.label}: ${selected.remainingCredits === null ? 'No cap' : `${selected.remainingCredits} credits`}` } : null) : null;
  const pinnedStillMounted = pinned === null || entries.some(entry => entry.conversationId === pinned.conversationId) || fallback?.conversationId === pinned.conversationId;
  useEffect(() => { if (!pinnedStillMounted) { setOpen(false); setPinned(null); } }, [pinnedStillMounted]);
  if (!spend || !chip) return null;
  return <RetainedSurface fill={false}><SpendSourcePopover chip={chip} options={spend.options} selectedWalletId={selected?.walletId ?? null} driveName={spend.options.find(option => option.driveName)?.driveName ?? null} open={open} onOpenChange={next => { setOpen(next); setPinned(next && target?.conversationId ? target as SpendContext : null); }} onChoose={!preview && target?.conversationId ? choose : undefined} /></RetainedSurface>;
}
