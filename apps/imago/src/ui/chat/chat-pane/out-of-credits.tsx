'use client';

// The out-of-credits alert in Imago's column (IMC-10.10): a turn refused with
// out_of_credits (402) says so in the v3 look, offers the retained "Buy credits"
// menu and, on cloud billing only, the Pro upsell that opens the plan page.

import { useChatErrorStore } from '@/retained/stores/useChatErrorStore';
import Link from '@/retained-adapters/link';
import { BuyCreditsButton } from '@/retained/components/billing/BuyCreditsButton';
import { isBillingEnabled } from '@/retained/lib/deployment-mode';
import { monthlyCreditsPhrase } from '@/retained/lib/subscription/credits';

export const OUT_OF_CREDITS_COPY =
  'You have run out of credits. Add credits or wait for your monthly allowance to reset.';

/** Pro's monthly allowance, from the plan constants: "Upgrade to Pro — 900 credits/month". */
export const UPGRADE_TO_PRO_LABEL = `Upgrade to Pro — ${monthlyCreditsPhrase('pro')}`;

/** Imago's own plan page (the Imago shell prefixes its base path). */
export const PLAN_HREF = '/account/plan';

const alertClass = 'mx-2 mb-2 flex flex-col gap-2 rounded-md border border-hairline bg-tint p-3';
const copyClass = 'text-sm text-status-danger';
const actionsClass = 'flex flex-wrap items-center gap-2';
const upsellClass = 'text-sm font-medium text-accent-deep underline underline-offset-2';

/** The alert for the shown conversation's out-of-credits cause; nothing for any other cause. */
export function OutOfCreditsAlert({ conversationId }: { readonly conversationId: string | null }) {
  const cause = useChatErrorStore((state) => (conversationId ? (state.byConversationId[conversationId] ?? null) : null));
  if (cause?.code !== 'out_of_credits') return null;
  return (
    <div role="alert" className={alertClass}>
      <p className={copyClass}>{OUT_OF_CREDITS_COPY}</p>
      <div className={actionsClass}>
        <BuyCreditsButton variant="default" size="sm" />
        {isBillingEnabled() && (
          <Link href={PLAN_HREF} className={upsellClass}>
            {UPGRADE_TO_PRO_LABEL}
          </Link>
        )}
      </div>
    </div>
  );
}
