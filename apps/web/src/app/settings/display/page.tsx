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
import { Eye, Loader2, ArrowLeft, Info } from 'lucide-react';

interface DisplaySetting {
  id: 'SHOW_TOKEN_COUNTS' | 'SHOW_CODE_TOGGLE';
  label: string;
  description: string;
  preferenceKey: 'showTokenCounts' | 'showCodeToggle';
}

const DISPLAY_SETTINGS: DisplaySetting[] = [
  {
    id: 'SHOW_TOKEN_COUNTS',
    label: 'Show AI token counts',
    description: 'Display context window usage and cost information in AI chats',
    preferenceKey: 'showTokenCounts',
  },
  {
    id: 'SHOW_CODE_TOGGLE',
    label: 'Show code editor toggle',
    description: 'Display Rich/Code toggle buttons for document and canvas pages',
    preferenceKey: 'showCodeToggle',
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
          Display Settings
        </h1>
        <p className="text-muted-foreground mt-2">
          Customize which UI elements are shown throughout the application.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Eye className="h-5 w-5" />
            Interface Options
          </CardTitle>
          <CardDescription>
            Toggle visibility of optional interface elements.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {DISPLAY_SETTINGS.map((setting) => {
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

      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
          These settings are saved to your account and will apply across all your devices.
        </AlertDescription>
      </Alert>
    </div>
  );
}
