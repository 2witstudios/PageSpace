'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/retained/hooks/useAuth';
import { useRouter } from '@/retained-adapters/navigation';
import useSWR from 'swr';
import { Switch } from '@/retained/components/ui/switch';
import { RadioGroup, RadioGroupItem } from '@/retained/components/ui/radio-group';
import { Label } from '@/retained/components/ui/label';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { patch, fetchWithAuth } from '@/retained/lib/auth/auth-fetch';
import { useToastPreferences } from '@/retained/hooks/useToastPreferences';
import type { ToastNotificationLevel } from '@/retained/lib/notifications/toast-eligible-types';
import {
  SettingsGroup,
  SettingsRow,
  SettingsScreen,
  SettingsSection,
} from '@/ui/settings/settings-screen/settings-screen';

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

type NotificationType =
  | 'PERMISSION_GRANTED'
  | 'PERMISSION_REVOKED'
  | 'PERMISSION_UPDATED'
  | 'PAGE_SHARED'
  | 'DRIVE_INVITED'
  | 'DRIVE_JOINED'
  | 'DRIVE_ROLE_CHANGED'
  | 'CONNECTION_REQUEST'
  | 'CONNECTION_ACCEPTED'
  | 'CONNECTION_REJECTED'
  | 'NEW_DIRECT_MESSAGE'
  | 'PRODUCT_UPDATE';

interface NotificationPreference {
  notificationType: NotificationType;
  emailEnabled: boolean;
}

interface PreferenceGroup {
  title: string;
  types: Array<{
    type: NotificationType;
    label: string;
    description: string;
  }>;
}

const PREFERENCE_GROUPS: PreferenceGroup[] = [
  {
    title: 'Direct messages',
    types: [
      {
        type: 'NEW_DIRECT_MESSAGE',
        label: 'New direct message',
        description: 'When someone sends you a direct message',
      },
    ],
  },
  {
    title: 'Collaboration',
    types: [
      {
        type: 'PERMISSION_GRANTED',
        label: 'Added as collaborator',
        description: 'When you’re given edit access to a page',
      },
      {
        type: 'PAGE_SHARED',
        label: 'Page shared',
        description: 'When someone shares a page with you',
      },
      {
        type: 'PERMISSION_UPDATED',
        label: 'Permissions updated',
        description: 'When your page permissions change',
      },
      {
        type: 'PERMISSION_REVOKED',
        label: 'Access removed',
        description: 'When your access to a page is removed',
      },
    ],
  },
  {
    title: 'Workspaces',
    types: [
      {
        type: 'DRIVE_INVITED',
        label: 'Added to workspace',
        description: 'When someone adds you to a workspace',
      },
      {
        type: 'DRIVE_JOINED',
        label: 'Joined workspace',
        description: 'When you join a workspace',
      },
      {
        type: 'DRIVE_ROLE_CHANGED',
        label: 'Role changed',
        description: 'When your role in a workspace is updated',
      },
    ],
  },
  {
    title: 'Connections',
    types: [
      {
        type: 'CONNECTION_REQUEST',
        label: 'Connection request',
        description: 'When someone wants to connect with you',
      },
      {
        type: 'CONNECTION_ACCEPTED',
        label: 'Connection accepted',
        description: 'When someone accepts your request',
      },
      {
        type: 'CONNECTION_REJECTED',
        label: 'Connection declined',
        description: 'When someone declines your request',
      },
    ],
  },
  {
    title: 'Product updates',
    types: [
      {
        type: 'PRODUCT_UPDATE',
        label: 'Product announcements',
        description: 'When we launch something new, like the SDK and CLI',
      },
    ],
  },
];

const TOAST_LEVEL_OPTIONS: Array<{ value: ToastNotificationLevel; label: string; description: string }> = [
  {
    value: 'all',
    label: 'All',
    description: 'Every notification: mentions, tasks, DMs, permissions.',
  },
  {
    value: 'mentions',
    label: 'Mentions & DMs',
    description: 'Mentions, DMs, task assignments, connection requests.',
  },
  {
    value: 'off',
    label: 'Off',
    description: 'No pop-ups. Check the bell when you choose.',
  },
];

export default function NotificationsSettingsPage() {
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const { level: toastLevel, isLoading: isToastLevelLoading, updateLevel: updateToastLevel } = useToastPreferences();

  const handleToastLevelChange = async (value: string) => {
    const level = value as ToastNotificationLevel;
    try {
      await updateToastLevel(level);
      toast.success('In-app pop-up preference updated');
    } catch (error) {
      toast.error('Failed to update in-app pop-up preference');
      console.error('Error updating toast notification level:', error);
    }
  };

  const { data, mutate, isLoading } = useSWR<{ preferences: NotificationPreference[] }>(
    user ? '/api/settings/notification-preferences' : null,
    fetcher
  );

  const [optimisticPreferences, setOptimisticPreferences] = useState<Map<NotificationType, boolean>>(
    new Map()
  );

  // Redirect if not authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/auth/signin');
    }
  }, [authLoading, user, router]);

  // Initialize optimistic preferences from server data
  useEffect(() => {
    if (data?.preferences) {
      const prefMap = new Map<NotificationType, boolean>();
      data.preferences.forEach((pref) => {
        prefMap.set(pref.notificationType, pref.emailEnabled);
      });
      setOptimisticPreferences(prefMap);
    }
  }, [data]);

  const handleToggle = async (notificationType: NotificationType, newValue: boolean) => {
    // Optimistic update
    setOptimisticPreferences((prev) => {
      const newMap = new Map(prev);
      newMap.set(notificationType, newValue);
      return newMap;
    });

    try {
      await patch('/api/settings/notification-preferences', {
        notificationType,
        emailEnabled: newValue,
      });

      toast.success(newValue ? 'Email notifications enabled' : 'Email notifications disabled');

      // Revalidate data
      mutate();
    } catch (error) {
      // Revert optimistic update on error
      setOptimisticPreferences((prev) => {
        const newMap = new Map(prev);
        newMap.set(notificationType, !newValue);
        return newMap;
      });

      toast.error('Failed to update notification preference');
      console.error('Error updating notification preference:', error);
    }
  };

  if (authLoading || isLoading || isToastLevelLoading) {
    return (
      <div className="container max-w-4xl mx-auto py-10 px-10 flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <SettingsScreen
      title="Notifications"
      lede="Everything still lands in the bell. These choose what interrupts you."
    >
      <SettingsSection
        title="In-app pop-ups"
        description="On the desktop app this also governs system notifications."
      >
        <RadioGroup aria-label="Pop-up level" value={toastLevel} onValueChange={handleToastLevelChange}>
          <SettingsGroup>
            {TOAST_LEVEL_OPTIONS.map((option) => (
              <SettingsRow
                key={option.value}
                label={
                  <Label htmlFor={`toast-level-${option.value}`} className="cursor-pointer font-medium">
                    {option.label}
                  </Label>
                }
                hint={option.description}
              >
                <RadioGroupItem value={option.value} id={`toast-level-${option.value}`} />
              </SettingsRow>
            ))}
          </SettingsGroup>
        </RadioGroup>
      </SettingsSection>

      <SettingsSection
        title="Email"
        description={user?.email ? `Sent to ${user.email}.` : 'Choose which notifications also arrive by email.'}
      >
        {PREFERENCE_GROUPS.map((group) => (
          <div key={group.title} className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-muted-foreground">{group.title}</h3>
            <SettingsGroup>
              {group.types.map((typeConfig) => {
                const isEnabled = optimisticPreferences.get(typeConfig.type) ?? true;

                return (
                  <SettingsRow
                    key={typeConfig.type}
                    label={typeConfig.label}
                    hint={typeConfig.description}
                  >
                    <Switch
                      id={typeConfig.type}
                      aria-label={`Email: ${typeConfig.label}`}
                      checked={isEnabled}
                      onCheckedChange={(checked) => handleToggle(typeConfig.type, checked)}
                    />
                  </SettingsRow>
                );
              })}
            </SettingsGroup>
          </div>
        ))}
      </SettingsSection>
    </SettingsScreen>
  );
}
