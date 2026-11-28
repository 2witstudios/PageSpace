'use client';

import { useEffect } from 'react';
import { useAuth } from '@/retained/hooks/useAuth';
import { useRouter } from '@/retained-adapters/navigation';
import { useDisplayPreferences } from '@/retained/hooks/useDisplayPreferences';
import { Switch } from '@/retained/components/ui/switch';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { useThemePreference } from '@/lib/theme/theme-provider';
import type { ThemePreference } from '@/lib/theme/theme-preference';
import {
  SettingsGroup,
  SettingsRow,
  SettingsScreen,
  SettingsSection,
} from '@/ui/settings/settings-screen/settings-screen';

interface DisplaySetting {
  id: 'SHOW_TOKEN_COUNTS' | 'SHOW_CODE_TOGGLE' | 'DEFAULT_MARKDOWN_MODE';
  label: string;
  description: string;
  preferenceKey: 'showTokenCounts' | 'showCodeToggle' | 'defaultMarkdownMode';
}

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string; preview: string }> = [
  { value: 'system', label: 'System', preview: 'bg-gradient-to-r from-neutral-900 to-neutral-50' },
  { value: 'light', label: 'Light', preview: 'bg-neutral-50' },
  { value: 'dark', label: 'Dark', preview: 'bg-neutral-900' },
];

const INTERFACE_SETTINGS: DisplaySetting[] = [
  {
    id: 'SHOW_TOKEN_COUNTS',
    label: 'Show AI token counts',
    description: 'Display context window usage in AI chats.',
    preferenceKey: 'showTokenCounts',
  },
  {
    id: 'SHOW_CODE_TOGGLE',
    label: 'Show Rich / Code view toggle',
    description: 'Keep Rich and Code buttons visible on document pages.',
    preferenceKey: 'showCodeToggle',
  },
];

const PAGE_SETTINGS: DisplaySetting[] = [
  {
    id: 'DEFAULT_MARKDOWN_MODE',
    label: 'Save new documents as Markdown',
    description: 'The default save format for document pages you create. Existing pages keep theirs.',
    preferenceKey: 'defaultMarkdownMode',
  },
];

export default function DisplaySettingsPage() {
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const { preferences, isLoading, updatePreference } = useDisplayPreferences();
  const { preference: theme, selectPreference } = useThemePreference();

  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/auth/signin');
    }
  }, [authLoading, user, router]);

  const handleToggle = async (setting: DisplaySetting, newValue: boolean) => {
    try {
      await updatePreference(setting.id, newValue);
      toast.success(newValue ? `${setting.label} enabled` : `${setting.label} disabled`);
    } catch {
      toast.error('Failed to update display setting');
    }
  };

  if (authLoading || isLoading) {
    return (
      <div className="container max-w-4xl mx-auto py-10 px-10 flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const renderSetting = (setting: DisplaySetting) => (
    <SettingsRow key={setting.id} label={setting.label} hint={setting.description}>
      <Switch
        id={setting.id}
        aria-label={setting.label}
        checked={preferences[setting.preferenceKey]}
        onCheckedChange={(checked) => handleToggle(setting, checked)}
      />
    </SettingsRow>
  );

  return (
    <SettingsScreen title="Display & pages" lede="Optional interface elements, and how new pages start out.">
      <SettingsSection title="Appearance" description="Follows your system unless you choose. Remembered in this browser.">
        <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-3">
          {THEME_OPTIONS.map((option) => (
            <label key={option.value} className="flex cursor-pointer flex-col gap-2">
              <span
                aria-hidden="true"
                className={`h-20 rounded-xl border-2 ${option.preview} ${theme === option.value ? 'border-primary' : 'border-border'}`}
              />
              <span className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="radio"
                  name="theme"
                  value={option.value}
                  checked={theme === option.value}
                  onChange={() => selectPreference(option.value)}
                  className="m-0"
                />
                {option.label}
              </span>
            </label>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title="Interface" description="Control optional interface elements. Saved to your account, so every device follows.">
        <SettingsGroup>{INTERFACE_SETTINGS.map(renderSetting)}</SettingsGroup>
      </SettingsSection>

      <SettingsSection title="New pages" description="Default behavior for how new document pages are created. Saved to your account, so every device follows.">
        <SettingsGroup>{PAGE_SETTINGS.map(renderSetting)}</SettingsGroup>
      </SettingsSection>
    </SettingsScreen>
  );
}
