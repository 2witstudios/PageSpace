'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Gauge } from 'lucide-react';
import { spendRefusalCopy, refusedCapWindow } from '@pagespace/lib/billing/spend-refusal-copy';
import type { SurfaceChoice } from '@pagespace/lib/billing/spend-surface';
import { Button } from '@/components/ui/button';
import type { AISpendRefusal } from '@/lib/ai/shared/aiErrorCause';
import { orgErrorMessage } from '@/lib/orgs/org-error-copy';
import { useConversationSpend } from '@/hooks/useConversationSpend';
import { useDriveWallet } from '@/hooks/useDriveWallet';
import { useSpendSurface } from './SpendSurface';

export interface SpendRefusalCardViewProps {
  refusal: AISpendRefusal;
  /** The person's sources in this conversation (labels and remaining amounts). */
  choices: SurfaceChoice[];
  /** For a reached cap on a drive wallet: the viewer's own remaining cap (consumer wallet view). */
  myCap: { dailyRemainingCents: number | null; monthlyRemainingCents: number | null } | null;
  now?: Date;
  onChoose: (walletId: string) => Promise<void>;
}

/**
 * The refusal card (Spec SPEND-4, UI-8; canvas v9 SpendSource; D-OW-39). The gate refused the
 * chosen source and charged nothing; the card says what happened, who controls the budget, and
 * offers the other sources the gate named. Choosing one changes this conversation's source; the
 * message is never sent by the card — the person sends it again.
 */
export function SpendRefusalCardView({ refusal, choices, myCap, now = new Date(), onChoose }: SpendRefusalCardViewProps) {
  const [pending, setPending] = useState<string | null>(null);
  const refused = refusal.source ? choices.find((c) => c.source === refusal.source) ?? null : null;
  const offered = refusal.options.flatMap((kind) => choices.filter((c) => c.source === kind && c.walletId !== refused?.walletId));
  const copy = spendRefusalCopy({
    reason: refusal.reason,
    source: refused ? { source: refused.source, label: refused.label, orgName: refused.orgName } : null,
    cap: refusal.reason === 'source_cap_reached' ? { window: refusedCapWindow(myCap), capCents: null } : undefined,
    hasOptions: offered.length > 0,
    now,
  });
  const Icon = refusal.reason === 'source_cap_reached' ? Gauge : AlertTriangle;

  const choose = async (choice: SurfaceChoice) => {
    setPending(choice.walletId);
    try {
      await onChoose(choice.walletId);
      toast.success(`This conversation now spends from ${choice.label}. Send your message again.`);
    } catch (error) {
      toast.error(orgErrorMessage(error, 'The source could not be changed. Try again.'));
    } finally {
      setPending(null);
    }
  };

  return (
    <div data-testid="spend-refusal-card" role="alert" className="flex items-start gap-2.5">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-sm font-medium text-foreground">{copy.title}</p>
        <p className="text-xs text-muted-foreground">{copy.body}</p>
        {offered.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-2">
            {offered.map((choice) => (
              <Button
                key={choice.walletId}
                type="button"
                variant="outline"
                size="sm"
                disabled={pending !== null}
                onClick={() => void choose(choice)}
              >
                {choice.source === 'own_credits' || choice.remainingCredits === null
                  ? choice.label
                  : `${choice.label} · ${choice.remainingCredits} credits`}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The card for the conversation of the surface it is rendered in (SpendSurfaceProvider): the
 * refused conversation itself, never another mounted chat's (review #2835 P1-1). Reads its
 * options, and the viewer's cap when a cap refused.
 */
export function SpendRefusalCard({ refusal }: { refusal: AISpendRefusal }) {
  const surface = useSpendSurface();
  const { spend, choose } = useConversationSpend(surface?.conversationId ?? null, {
    driveId: surface?.driveId ?? null,
    isGlobal: surface?.isGlobal ?? false,
  });
  const capDriveId = refusal.reason === 'source_cap_reached' && refusal.source === 'drive_wallet' ? spend?.driveId ?? null : null;
  const { wallet } = useDriveWallet(capDriveId);
  return (
    <SpendRefusalCardView
      refusal={refusal}
      choices={spend?.options ?? []}
      myCap={wallet?.myCap ?? null}
      onChoose={(walletId) => choose(walletId)}
    />
  );
}
