'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Bell, Mail, MessageSquare, Loader2, ArrowLeft, Info } from 'lucide-react';
import { patch, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useToastPreferences } from '@/hooks/useToastPreferences';
import type { ToastNotificationLevel } from '@/lib/notifications/toast-eligible-types';

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
  | 'NEW_DIRECT_MESSAGE';

interface NotificationPreference {
  notificationType: NotificationType;
  emailEnabled: boolean;
}

interface PreferenceGroup {
  title: string;
  description: string;
  types: Array<{
    type: NotificationType;
    label: string;
    description: string;
  }>;
}

const PREFERENCE_GROUPS: PreferenceGroup[] = [
  {
    title: 'Workspace Additions',
    description: 'Get notified when you\'re added to a workspace',
    types: [
      {
        type: 'DRIVE_INVITED',
        label: 'Added to Workspace',
        description: 'When someone adds you to a workspace',
      },
      {
        type: 'DRIVE_JOINED',
        label: 'Joined Workspace',
        description: 'When you join a workspace',
      },
    ],
  },
  {
    title: 'Workspace Management',
    description: 'Get notified when your workspace role or permissions change',
    types: [
      {
        type: 'DRIVE_ROLE_CHANGED',
        label: 'Role Changed',
        description: 'When your role in a workspace is updated',
      },
    ],
  },
  {
    title: 'Direct Messages',
    description: 'Notifications for direct messages from other users',
    types: [
      {
        type: 'NEW_DIRECT_MESSAGE',
        label: 'New Direct Message',
        description: 'When someone sends you a direct message',
      },
    ],
  },
  {
    title: 'Connections',
    description: 'Notifications about connection requests',
    types: [
      {
        type: 'CONNECTION_REQUEST',
        label: 'Connection Request',
        description: 'When someone wants to connect with you',
      },
      {
        type: 'CONNECTION_ACCEPTED',
        label: 'Connection Accepted',
        description: 'When someone accepts your connection request',
      },
      {
        type: 'CONNECTION_REJECTED',
        label: 'Connection Declined',
        description: 'When someone declines your connection request',
      },
    ],
  },
  {
    title: 'Collaboration',
    description: 'Get notified when you\'re added as a collaborator or when pages are shared with you',
    types: [
      {
        type: 'PERMISSION_GRANTED',
        label: 'Added as Collaborator',
        description: 'When you\'re given edit access to a page',
      },
      {
        type: 'PAGE_SHARED',
        label: 'Page Shared',
        description: 'When someone shares a page with you',
      },
      {
        type: 'PERMISSION_UPDATED',
        label: 'Permissions Updated',
        description: 'When your page permissions are changed',
      },
      {
        type: 'PERMISSION_REVOKED',
        label: 'Access Removed',
        description: 'When your access to a page is removed',
      },
    ],
  },
];

const TOAST_LEVEL_OPTIONS: Array<{ value: ToastNotificationLevel; label: string; description: string }> = [
  {
    value: 'all',
    label: 'All notifications',
    description: 'Show a pop-up for every notification (mentions, tasks, DMs, permissions, and more).',
  },
  {
    value: 'mentions',
    label: 'Mentions & DMs only',
    description: 'Only pop up for things that directly involve you: mentions, direct messages, task assignments, and connection requests.',
  },
  {
    value: 'off',
    label: 'Off',
    description: "Don't show pop-ups. You'll still see everything in the notification bell.",
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
          <Bell className="h-8 w-8" />
          Notifications
        </h1>
        <p className="text-muted-foreground mt-2">
          Manage how and when PageSpace notifies you.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5" />
            In-app Pop-ups
          </CardTitle>
          <CardDescription>
            Choose how live pop-up notifications show up while you&apos;re using PageSpace. This doesn&apos;t affect the notification bell, which always shows everything.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RadioGroup
            value={toastLevel}
            onValueChange={handleToastLevelChange}
            className="space-y-3"
          >
            {TOAST_LEVEL_OPTIONS.map((option) => (
              <div
                key={option.value}
                className="flex items-start gap-3 p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
              >
                <RadioGroupItem value={option.value} id={`toast-level-${option.value}`} className="mt-0.5" />
                <Label htmlFor={`toast-level-${option.value}`} className="flex-1 cursor-pointer font-normal">
                  <span className="text-sm font-medium">{option.label}</span>
                  <p className="text-xs text-muted-foreground mt-0.5">{option.description}</p>
                </Label>
              </div>
            ))}
          </RadioGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            Email Notification Preferences
          </CardTitle>
          <CardDescription>
            Choose which types of notifications you want to receive via email.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {PREFERENCE_GROUPS.map((group, groupIndex) => (
            <div key={group.title}>
              {groupIndex > 0 && <Separator className="my-6" />}

              <div className="space-y-4">
                <div>
                  <h3 className="font-semibold text-base">{group.title}</h3>
                  <p className="text-sm text-muted-foreground">{group.description}</p>
                </div>

                <div className="space-y-3">
                  {group.types.map((typeConfig) => {
                    const isEnabled = optimisticPreferences.get(typeConfig.type) ?? true;

                    return (
                      <div
                        key={typeConfig.type}
                        className="flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
                      >
                        <div className="space-y-0.5">
                          <Label
                            htmlFor={typeConfig.type}
                            className="text-sm font-medium cursor-pointer"
                          >
                            {typeConfig.label}
                          </Label>
                          <p className="text-xs text-muted-foreground">
                            {typeConfig.description}
                          </p>
                        </div>
                        <Switch
                          id={typeConfig.type}
                          checked={isEnabled}
                          onCheckedChange={(checked) => handleToggle(typeConfig.type, checked)}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
          <strong>Note:</strong> Turning off email notifications won&apos;t affect in-app notifications.
          You&apos;ll still see all notifications when you&apos;re signed in to PageSpace.
        </AlertDescription>
      </Alert>
    </div>
  );
}
