import { Info } from "lucide-react";
import { CREDITS_IN_TRANSITION } from "@/lib/credits";

/**
 * TRANSITION: disclaimer shown while AI-credit pricing is rolling out. The marketing site
 * advertises the new credit model, but some production accounts remain on the legacy
 * daily-limit experience until they're switched over. Renders nothing once
 * `CREDITS_IN_TRANSITION` is flipped off. Matches the amber "beta notice" style used on
 * the downloads page. Remove when AI credits are live for all accounts.
 */
export function CreditsTransitionNotice() {
  if (!CREDITS_IN_TRANSITION) return null;

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-6">
      <div className="flex items-start gap-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10 flex-shrink-0">
          <Info className="h-5 w-5 text-amber-600" />
        </div>
        <div>
          <h3 className="font-semibold mb-1">AI credits pricing is rolling out</h3>
          <p className="text-sm text-muted-foreground">
            We&#39;re moving from daily AI limits to monthly AI credits. The allowances below
            are what each plan includes once credits are active for your account — some
            existing accounts remain on the previous daily limits until they&#39;re switched
            over. Your documents, tasks, and collaboration are unaffected.
          </p>
        </div>
      </div>
    </div>
  );
}
