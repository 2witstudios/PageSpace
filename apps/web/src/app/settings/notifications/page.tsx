'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { Bell, Mail, Loader2 } from 'lucide-react';

const fetcher = (url: string) => fetch(url).then((res) => res.json());

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
    title: 'Workspace Invitations',
    description: 'Get notified when you\'re invited to join a workspace',
    types: [
      {
        type: 'DRIVE_INVITED',
        label: 'Drive Invitation',
        description: 'When someone invites you to join a workspace',
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

export default function NotificationsSettingsPage() {
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();

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
      const response = await fetch('/api/settings/notification-preferences', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          notificationType,
          emailEnabled: newValue,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to update preference');
      }

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

  if (authLoading || isLoading) {
    return (
      <div className="container max-w-4xl mx-auto py-10 flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="container max-w-4xl mx-auto py-10 space-y-8">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Bell className="h-8 w-8" />
          Email Notifications
        </h1>
        <p className="text-muted-foreground mt-2">
          Manage which notifications you receive via email. You&apos;ll still see all notifications within PageSpace.
        </p>
      </div>

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

      <Card className="bg-blue-50/50 border-blue-200">
        <CardContent className="pt-6">
          <p className="text-sm text-blue-900">
            <strong>Note:</strong> Turning off email notifications won&apos;t affect in-app notifications.
            You&apos;ll still see all notifications when you&apos;re signed in to PageSpace.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
