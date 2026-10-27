'use client';

import { useEffect, useState } from 'react';
import Link from '@/retained-adapters/link';
import { Button } from '@/retained/components/ui/button';
import { Switch } from '@/retained/components/ui/switch';
import { MarketingLink } from '@/retained/components/ui/MarketingLink';
import { toast } from 'sonner';
import { useConsentStore } from '@/retained/stores/useConsentStore';
import { useCapacitor } from '@/retained/hooks/useCapacitor';
import {
  SettingsGroup,
  SettingsRow,
  SettingsScreen,
  SettingsSection,
} from '@/ui/settings/settings-screen/settings-screen';

/**
 * Cookie & privacy settings — lets a user review or withdraw cookie consent at any time.
 * Thin shell over the pure consent store: all decision logic lives in @pagespace/lib/consent.
 * Consent is device/browser-scoped (stored in the ps_consent cookie), matching standard CMP
 * behaviour; this page edits that cookie via the same store actions the banner uses.
 *
 * Hidden on native apps (classic marks this route nativeHidden): the cookie banner is
 * a web-only surface there.
 */
export default function PrivacySettingsPage() {
  const hydrate = useConsentStore((s) => s.hydrate);
  const state = useConsentStore((s) => s.state);
  const saveCustom = useConsentStore((s) => s.saveCustom);
  const rejectNonEssential = useConsentStore((s) => s.rejectNonEssential);
  const { isNative } = useCapacitor();

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

  if (isNative) return null;

  return (
    <SettingsScreen
      title="Privacy"
      lede="Choose which cookies PageSpace may set in this browser. You can change this any time."
    >
      <SettingsSection
        title="Cookie preferences"
        description={`Last updated: ${decidedAtLabel}.`}
      >
        <SettingsGroup label="Cookie preferences">
          <SettingsRow
            label={
              <span className="flex items-center gap-2">
                Strictly necessary
                <span className="rounded-full bg-tint px-2 py-px text-xs font-normal text-muted-foreground">Always on</span>
              </span>
            }
            hint="Sign-in, security and load balancing. PageSpace can’t work without these."
          >
            <Switch
              checked
              disabled
              aria-disabled="true"
              aria-label="Strictly necessary cookies"
            />
          </SettingsRow>
          <SettingsRow
            label="Analytics"
            hint="Anonymous usage that tells us which features help and which get in the way."
          >
            <Switch
              checked={analytics}
              onCheckedChange={setAnalytics}
              aria-label="Analytics cookies"
            />
          </SettingsRow>
          <SettingsRow
            label="Preferences"
            hint="Remember interface choices like pane widths on this device."
          >
            <Switch
              checked={preferences}
              onCheckedChange={setPreferences}
              aria-label="Preference cookies"
            />
          </SettingsRow>
        </SettingsGroup>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" onClick={handleWithdraw}>
            Withdraw optional cookies
          </Button>
          <Button onClick={handleSave}>Save preferences</Button>
        </div>
      </SettingsSection>

      <SettingsSection title="Your data">
        <SettingsGroup label="Your data">
          <SettingsRow label="Download a copy of everything" hint="Profile → Your data">
            <Link href="/account/account" className="text-sm text-accent-deep hover:underline">Profile</Link>
          </SettingsRow>
          <SettingsRow label="What the AI remembers about you" hint="Personalization">
            <Link href="/account/personalization" className="text-sm text-accent-deep hover:underline">Personalization</Link>
          </SettingsRow>
          <SettingsRow label="Delete your account" hint="Profile → Delete account">
            <Link href="/account/account" className="text-sm text-accent-deep hover:underline">Profile</Link>
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      <p className="text-sm text-muted-foreground">
        Read the{' '}
        <MarketingLink href="/privacy" className="text-accent-deep hover:underline">Privacy Policy</MarketingLink>
        {' '}and{' '}
        <MarketingLink href="/terms" className="text-accent-deep hover:underline">Terms of Service</MarketingLink>.
      </p>
    </SettingsScreen>
  );
}
