'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { ArrowLeft, Cookie } from 'lucide-react';
import { useConsentStore } from '@/stores/useConsentStore';

/**
 * Cookie & privacy settings — lets a user review or withdraw cookie consent at any time.
 * Thin shell over the pure consent store: all decision logic lives in @pagespace/lib/consent.
 * Consent is device/browser-scoped (stored in the ps_consent cookie), matching standard CMP
 * behaviour; this page edits that cookie via the same store actions the banner uses.
 */
export default function PrivacySettingsPage() {
  const router = useRouter();
  const hydrate = useConsentStore((s) => s.hydrate);
  const state = useConsentStore((s) => s.state);
  const saveCustom = useConsentStore((s) => s.saveCustom);
  const rejectNonEssential = useConsentStore((s) => s.rejectNonEssential);

  const [analytics, setAnalytics] = useState(false);
  const [preferences, setPreferences] = useState(false);

  // Read the current choice from the cookie on mount, then seed the toggles from it.
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    setAnalytics(state.categories.analytics);
    setPreferences(state.categories.preferences);
  }, [state]);

  const decidedAtLabel = state.decidedAt
    ? new Date(state.decidedAt).toLocaleString()
    : 'No choice recorded yet';

  const handleSave = () => {
    saveCustom({ analytics, preferences });
    toast.success('Cookie preferences saved');
  };

  const handleWithdraw = () => {
    rejectNonEssential();
    setAnalytics(false);
    setPreferences(false);
    toast.success('Optional cookies withdrawn');
  };

  return (
    <div className="container max-w-4xl mx-auto py-10 px-10 space-y-8">
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/settings')}
          className="mb-4"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Settings
        </Button>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Cookie className="h-8 w-8" />
          Privacy &amp; Cookies
        </h1>
        <p className="text-muted-foreground mt-2">
          Review or change which cookies you allow. Your choice is remembered on this device until
          you change it here or clear your browser data. Last updated: {decidedAtLabel}.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Cookie preferences</CardTitle>
          <CardDescription>
            Strictly necessary cookies are always on because the app can&apos;t run without them.
            Optional cookies are off until you turn them on.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-4 opacity-70">
            <div className="space-y-0.5">
              <Label htmlFor="consent-necessary">Strictly necessary</Label>
              <p className="text-sm text-muted-foreground">
                Required to run PageSpace (sign-in, security, core features). Always on.
              </p>
            </div>
            <Switch id="consent-necessary" checked disabled />
          </div>

          <Separator />

          <div className="flex items-start justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="consent-analytics">Analytics</Label>
              <p className="text-sm text-muted-foreground">
                Helps us understand product usage so we can improve PageSpace.
              </p>
            </div>
            <Switch id="consent-analytics" checked={analytics} onCheckedChange={setAnalytics} />
          </div>

          <Separator />

          <div className="flex items-start justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="consent-preferences">Preferences</Label>
              <p className="text-sm text-muted-foreground">
                Remembers choices and enables third-party sign-in (Google).
              </p>
            </div>
            <Switch
              id="consent-preferences"
              checked={preferences}
              onCheckedChange={setPreferences}
            />
          </div>

          <Separator />

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" onClick={handleWithdraw}>
              Withdraw optional cookies
            </Button>
            <Button onClick={handleSave}>Save preferences</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
