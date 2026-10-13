'use client';

import { useState } from 'react';
import { MarketingLink } from '@/components/ui/MarketingLink';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useConsentStore } from '@/stores/useConsentStore';
import { isImagoEnabled } from '@/lib/imago/imago-enabled';

// v3 (Imago-enabled) look, per the Cookie consent board. Classic markup keeps its own classes.
const V3 = {
  dialog:
    'fixed inset-x-4 bottom-4 z-[100] rounded-xl border border-[oklch(0.90_0.005_230/0.8)] bg-[oklch(0.995_0.002_240/0.95)] p-4 text-[oklch(0.15_0.01_220)] shadow-[0_10px_30px_rgb(0_0_0/0.12)] backdrop-blur-[12px]',
  copy: 'text-[13.5px] leading-[1.55] text-[oklch(0.30_0.012_220)]',
  panel: 'flex flex-col gap-2 rounded-[10px] bg-[oklch(0.15_0.01_220/0.035)] p-3',
  row: 'flex items-center gap-2.5',
  label: 'text-[13px] font-normal leading-[1.45]',
  button: 'h-8 rounded-lg px-3.5 text-[13px] font-medium shadow-none',
  primary: 'bg-[oklch(0.50_0.16_235)] text-[oklch(0.98_0.005_235)] hover:bg-[oklch(0.46_0.16_235)]',
  outline: 'border-[oklch(0.90_0.005_230)] bg-transparent text-[oklch(0.15_0.01_220)] hover:bg-[oklch(0.97_0.004_235)]',
  ghost: 'text-[oklch(0.15_0.01_220)] hover:bg-[oklch(0.15_0.01_220/0.05)]',
} as const;

/**
 * GDPR/ePrivacy cookie consent banner. All decision logic lives in the pure
 * @pagespace/lib/consent functions (via useConsentStore); this is a thin UI shell.
 */
export function CookieBanner() {
  const acceptAll = useConsentStore((s) => s.acceptAll);
  const rejectNonEssential = useConsentStore((s) => s.rejectNonEssential);
  const saveCustom = useConsentStore((s) => s.saveCustom);

  const imago = isImagoEnabled();
  const [customizing, setCustomizing] = useState(false);
  // Seed from the stored decision so a reopened banner reflects current choices.
  const [analytics, setAnalytics] = useState(
    () => useConsentStore.getState().state.categories.analytics,
  );
  const [preferences, setPreferences] = useState(
    () => useConsentStore.getState().state.categories.preferences,
  );

  return (
    <div
      role="dialog"
      aria-label="Cookie consent"
      aria-live="polite"
      className={
        imago
          ? V3.dialog
          : 'fixed inset-x-0 bottom-0 z-[100] border-t border-border bg-background/95 p-4 shadow-lg backdrop-blur md:inset-x-4 md:bottom-4 md:rounded-xl md:border'
      }
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        <div className={imago ? V3.copy : 'text-sm text-muted-foreground'}>
          <p>
            We use strictly necessary cookies to run PageSpace, plus optional cookies for analytics
            and preferences. Necessary cookies are always on. You can accept all, reject the
            optional ones, or choose which to allow. See our{' '}
            <MarketingLink href="/privacy" className="underline hover:text-foreground">
              Privacy Policy
            </MarketingLink>{' '}
            and{' '}
            <MarketingLink href="/cookies" className="underline hover:text-foreground">
              Cookie Policy
            </MarketingLink>{' '}
            for details.
          </p>
        </div>

        {customizing && (
          <div className={imago ? V3.panel : 'flex flex-col gap-2 rounded-lg border border-border p-3'}>
            <div className={imago ? `${V3.row} opacity-70` : 'flex items-start gap-2 opacity-70'}>
              <Checkbox id="consent-necessary" checked disabled className={imago ? '' : 'mt-0.5'} />
              <Label htmlFor="consent-necessary" className={imago ? V3.label : 'text-xs font-normal leading-snug'}>
                Strictly necessary — required to run the app (always on)
              </Label>
            </div>
            <div className={imago ? V3.row : 'flex items-start gap-2'}>
              <Checkbox
                id="consent-analytics"
                checked={analytics}
                onCheckedChange={(c) => setAnalytics(c === true)}
                className={imago ? '' : 'mt-0.5'}
              />
              <Label htmlFor="consent-analytics" className={imago ? V3.label : 'text-xs font-normal leading-snug'}>
                Analytics — helps us understand product usage
              </Label>
            </div>
            <div className={imago ? V3.row : 'flex items-start gap-2'}>
              <Checkbox
                id="consent-preferences"
                checked={preferences}
                onCheckedChange={(c) => setPreferences(c === true)}
                className={imago ? '' : 'mt-0.5'}
              />
              <Label htmlFor="consent-preferences" className={imago ? V3.label : 'text-xs font-normal leading-snug'}>
                Preferences — remembers choices and enables third-party sign-in (Google)
              </Label>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          {customizing ? (
            <Button
              size="sm"
              className={imago ? `${V3.button} ${V3.primary}` : undefined}
              onClick={() => saveCustom({ analytics, preferences })}
            >
              Save choices
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className={imago ? `${V3.button} ${V3.ghost}` : undefined}
              onClick={() => setCustomizing(true)}
            >
              Customize
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className={imago ? `${V3.button} ${V3.outline}` : undefined}
            onClick={() => rejectNonEssential()}
          >
            Reject optional
          </Button>
          <Button
            size="sm"
            className={imago ? `${V3.button} ${V3.primary}` : undefined}
            onClick={() => acceptAll()}
          >
            Accept all
          </Button>
        </div>
      </div>
    </div>
  );
}
