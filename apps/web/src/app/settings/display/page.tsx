'use client';

import { useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useRouter } from 'next/navigation';
import { useDisplayPreferences } from '@/hooks/useDisplayPreferences';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Eye, Loader2, ArrowLeft, Info, FileText } from 'lucide-react';

interface DisplaySetting {
  id: 'SHOW_TOKEN_COUNTS' | 'SHOW_CODE_TOGGLE' | 'DEFAULT_MARKDOWN_MODE';
  label: string;
  description: string;
  preferenceKey: 'showTokenCounts' | 'showCodeToggle' | 'defaultMarkdownMode';
}

interface DisplaySettingsSection {
  key: string;
  title: string;
  description: string;
  icon: typeof Eye;
  settings: DisplaySetting[];
}

const INTERFACE_SETTINGS: DisplaySetting[] = [
  {
    id: 'SHOW_TOKEN_COUNTS',
    label: 'Show AI token counts',
    description: 'Display context window usage and cost information in AI chats',
    preferenceKey: 'showTokenCounts',
  },
  {
    id: 'SHOW_CODE_TOGGLE',
    label: 'Show Rich/Code view toggle',
    description: 'Display stable Rich and Code buttons for document pages',
    preferenceKey: 'showCodeToggle',
  },
];

const PAGE_SETTINGS: DisplaySetting[] = [
  {
    id: 'DEFAULT_MARKDOWN_MODE',
    label: 'Default new document pages to Markdown',
    description: 'Sets the global default save format for newly created document pages',
    preferenceKey: 'defaultMarkdownMode',
  },
];

const SETTINGS_SECTIONS: DisplaySettingsSection[] = [
  {
    key: 'global-page-settings',
    title: 'Global Page Settings',
    description: 'Set default behavior for how new document pages are created.',
    icon: FileText,
    settings: PAGE_SETTINGS,
  },
  {
    key: 'display-settings',
    title: 'Display Settings',
    description: 'Control optional interface elements.',
    icon: Eye,
    settings: INTERFACE_SETTINGS,
  },
];

export default function DisplaySettingsPage() {
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const { preferences, isLoading, updatePreference } = useDisplayPreferences();

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
          <Eye className="h-8 w-8" />
          Display & Page Settings
        </h1>
        <p className="text-muted-foreground mt-2">
          Configure global page defaults and optional UI elements.
        </p>
      </div>

      {SETTINGS_SECTIONS.map((section) => (
        <Card key={section.key}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <section.icon className="h-5 w-5" />
              {section.title}
            </CardTitle>
            <CardDescription>{section.description}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {section.settings.map((setting) => {
              const isEnabled = preferences[setting.preferenceKey];

              return (
                <div
                  key={setting.id}
                  className="flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
                >
                  <div className="space-y-0.5">
                    <Label
                      htmlFor={setting.id}
                      className="text-sm font-medium cursor-pointer"
                    >
                      {setting.label}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {setting.description}
                    </p>
                  </div>
                  <Switch
                    id={setting.id}
                    checked={isEnabled}
                    onCheckedChange={(checked) => handleToggle(setting, checked)}
                  />
                </div>
              );
            })}
          </CardContent>
        </Card>
      ))}

      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
          These settings are saved to your account and apply across all your devices.
        </AlertDescription>
      </Alert>
    </div>
  );
}
