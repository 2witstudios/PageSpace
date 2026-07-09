'use client';

import { useEffect, useRef } from 'react';
import { useNotificationStore } from '@/stores/useNotificationStore';
import type { StoredNotification } from '@/lib/notifications/resolve-destination';

/**
 * Subscribes to useNotificationStore and invokes `onNew` once for each
 * notification that is new since mount, or updated in place (e.g. a
 * NEW_DIRECT_MESSAGE bumped to the top with a new message/timestamp).
 *
 * Shared by every notification-delivery surface (toast, native OS banner) so
 * the "is this event worth considering" gate can never diverge between them.
 * Only the current top notification is compared against the last one seen —
 * the store always prepends/re-sorts so the top is the only slot that can
 * change, keeping this O(1) instead of an ever-growing per-id map.
 *
 * Pass `enabled: false` to skip subscribing entirely (e.g. a surface that
 * only applies on some platforms) without violating the rules of hooks.
 */
export function useNewStoreNotification(
  onNew: (notification: StoredNotification) => void,
  enabled = true,
) {
  const mountTimeRef = useRef(Date.now());
  const lastSeenRef = useRef<{ id: string; signature: string } | null>(null);
  const onNewRef = useRef(onNew);
  onNewRef.current = onNew;

  useEffect(() => {
    if (!enabled) return;

    return useNotificationStore.subscribe((state) => {
      const top = state.notifications[0] as StoredNotification | undefined;
      if (!top) return;
      const createdAt = new Date(top.createdAt);
      if (createdAt.getTime() < mountTimeRef.current) return;

      const signature = `${top.message}|${createdAt.toISOString()}`;
      if (lastSeenRef.current?.id === top.id && lastSeenRef.current.signature === signature) return;
      lastSeenRef.current = { id: top.id, signature };

      onNewRef.current(top);
    });
  }, [enabled]);
}
