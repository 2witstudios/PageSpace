'use client';

import { useEffect, useRef } from 'react';
import { useNotificationStore } from '@/stores/useNotificationStore';
import type { StoredNotification } from '@/lib/notifications/resolve-destination';

// Cap on tracked notification ids. A single last-seen ref isn't enough: if
// the top notification is dismissed/deleted, the previous top can resurface
// unchanged (same id+signature) and must NOT be treated as new again. A
// per-id map is required for that — capped so a long-lived session doesn't
// grow it unbounded, evicting the oldest entry (Map preserves insertion
// order) once the cap is exceeded.
const MAX_TRACKED_IDS = 200;

/**
 * Subscribes to useNotificationStore and invokes `onNew` once for each
 * notification that is new since mount, or updated in place (e.g. a
 * NEW_DIRECT_MESSAGE bumped to the top with a new message/timestamp).
 *
 * Shared by every notification-delivery surface (toast, native OS banner) so
 * the "is this event worth considering" gate can never diverge between them.
 *
 * Pass `enabled: false` to skip subscribing entirely (e.g. a surface that
 * only applies on some platforms) without violating the rules of hooks.
 */
export function useNewStoreNotification(
  onNew: (notification: StoredNotification) => void,
  enabled = true,
) {
  const mountTimeRef = useRef(Date.now());
  const seenRef = useRef(new Map<string, string>());
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
      if (seenRef.current.get(top.id) === signature) return;
      seenRef.current.set(top.id, signature);
      if (seenRef.current.size > MAX_TRACKED_IDS) {
        const oldestId = seenRef.current.keys().next().value;
        if (oldestId !== undefined) seenRef.current.delete(oldestId);
      }

      onNewRef.current(top);
    });
  }, [enabled]);
}
