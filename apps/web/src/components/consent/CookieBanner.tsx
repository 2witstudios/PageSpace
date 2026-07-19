'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useConsentStore } from '@/stores/useConsentStore';

/**
 * GDPR/ePrivacy cookie consent banner. All decision logic lives in the pure
 * @pagespace/lib/consent functions (via useConsentStore); this is a thin UI shell.
 */
export function CookieBanner() {
  const acceptAll = useConsentStore((s) => s.acceptAll);
  const rejectNonEssential = useConsentStore((s) => s.rejectNonEssential);
  const saveCustom = useConsentStore((s) => s.saveCustom);

  const [customizing, setCustomizing] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [preferences, setPreferences] = useState(false);

  return (
    <div
      role="dialog"
      aria-label="Cookie consent"
      aria-live="polite"
      className="fixed inset-x-0 bottom-0 z-[100] border-t border-border bg-background/95 p-4 shadow-lg backdrop-blur md:inset-x-4 md:bottom-4 md:rounded-xl md:border"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        <div className="text-sm text-muted-foreground">
          <p>
            We use strictly necessary cookies to run PageSpace, plus optional cookies for analytics
            and preferences. Necessary cookies are always on. You can accept all, reject the
            optional ones, or choose which to allow. See our{' '}
            <Link href="/privacy" className="underline hover:text-foreground">
              Privacy Policy
            </Link>{' '}
            and{' '}
            <Link href="/cookies" className="underline hover:text-foreground">
              Cookie Policy
            </Link>{' '}
            for details.
          </p>
        </div>

        {customizing && (
          <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <div className="flex items-start gap-2 opacity-70">
              <Checkbox id="consent-necessary" checked disabled className="mt-0.5" />
              <Label htmlFor="consent-necessary" className="text-xs font-normal leading-snug">
                Strictly necessary — required to run the app (always on)
              </Label>
            </div>
            <div className="flex items-start gap-2">
              <Checkbox
                id="consent-analytics"
                checked={analytics}
                onCheckedChange={(c) => setAnalytics(c === true)}
                className="mt-0.5"
              />
              <Label htmlFor="consent-analytics" className="text-xs font-normal leading-snug">
                Analytics — helps us understand product usage
              </Label>
            </div>
            <div className="flex items-start gap-2">
              <Checkbox
                id="consent-preferences"
                checked={preferences}
                onCheckedChange={(c) => setPreferences(c === true)}
                className="mt-0.5"
              />
              <Label htmlFor="consent-preferences" className="text-xs font-normal leading-snug">
                Preferences — remembers choices and enables third-party sign-in (Google)
              </Label>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          {customizing ? (
            <Button size="sm" onClick={() => saveCustom({ analytics, preferences })}>
              Save choices
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setCustomizing(true)}>
              Customize
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => rejectNonEssential()}>
            Reject optional
          </Button>
          <Button size="sm" onClick={() => acceptAll()}>
            Accept all
          </Button>
        </div>
      </div>
    </div>
  );
}
