'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useNotificationStore } from '@/stores/useNotificationStore';

interface PushNotificationSchema {
  title?: string;
  body?: string;
  id: string;
  data: Record<string, unknown>;
}

interface ActionPerformed {
  actionId: string;
  notification: PushNotificationSchema;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function resolveDestination(data: Record<string, unknown>): string | null {
  const type = asString(data.type);
  if (!type) return null;

  if (type === 'EMAIL_VERIFICATION_REQUIRED') {
    return '/settings/account';
  }

  if (type === 'TOS_PRIVACY_UPDATED') {
    return asString(data.documentUrl) ?? '/dashboard';
  }

  if (type === 'NEW_DIRECT_MESSAGE') {
    const conversationId = asString(data.conversationId);
    return conversationId ? `/dashboard/inbox/dm/${conversationId}` : '/dashboard/inbox';
  }

  if (type === 'MENTION' || type === 'TASK_ASSIGNED') {
    const driveId = asString(data.driveId);
    const pageId = asString(data.pageId) ?? asString(data.taskListPageId);
    if (driveId && pageId) {
      const taskId = asString(data.taskId);
      return type === 'TASK_ASSIGNED' && taskId
        ? `/dashboard/${driveId}/${pageId}?task=${taskId}`
        : `/dashboard/${driveId}/${pageId}`;
    }
  }

  if (
    type === 'PAGE_SHARED' ||
    type === 'PERMISSION_GRANTED' ||
    type === 'PERMISSION_UPDATED' ||
    type === 'PERMISSION_REVOKED'
  ) {
    const driveId = asString(data.driveId);
    const pageId = asString(data.pageId);
    if (driveId && pageId) return `/dashboard/${driveId}/${pageId}`;
    if (driveId) return `/dashboard/${driveId}`;
  }

  if (
    type === 'DRIVE_INVITED' ||
    type === 'DRIVE_JOINED' ||
    type === 'DRIVE_ROLE_CHANGED'
  ) {
    const driveId = asString(data.driveId);
    if (driveId) return `/dashboard/${driveId}`;
  }

  if (
    type === 'CONNECTION_REQUEST' ||
    type === 'CONNECTION_ACCEPTED' ||
    type === 'CONNECTION_REJECTED'
  ) {
    return '/dashboard/connections';
  }

  return '/dashboard';
}

export function PushActionHandler() {
  const router = useRouter();
  const handleNotificationRead = useNotificationStore((s) => s.handleNotificationRead);

  useEffect(() => {
    const onAction = (event: Event) => {
      const detail = (event as CustomEvent<ActionPerformed>).detail;
      const data = detail?.notification?.data ?? {};

      const notificationId = asString(data.notificationId);
      if (notificationId) {
        void handleNotificationRead(notificationId);
      }

      const destination = resolveDestination(data);
      if (destination) {
        router.push(destination);
      }
    };

    window.addEventListener('push:action', onAction as EventListener);
    return () => window.removeEventListener('push:action', onAction as EventListener);
  }, [router, handleNotificationRead]);

  return null;
}
