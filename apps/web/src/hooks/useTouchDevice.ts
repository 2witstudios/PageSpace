"use client";

import { useSyncExternalStore } from "react";

import { detectCoarsePointer } from "@/lib/pointer-capability";

/**
 * Detects if the current device is a touch device.
 *
 * Delegates to `detectCoarsePointer()` — `(pointer: coarse)` alone is not enough,
 * because a desktop-class iPad (the Capacitor app's default content mode, and
 * iPad Safari's "Request Desktop Site") reports `pointer: fine`.
 */

const TOUCH_QUERY = "(pointer: coarse)";

const subscribe = (callback: () => void) => {
  if (typeof window === "undefined") {
    return () => {};
  }

  const mediaQueryList = window.matchMedia(TOUCH_QUERY);
  const listener = () => callback();

  if (mediaQueryList.addEventListener) {
    mediaQueryList.addEventListener("change", listener);
  } else {
    mediaQueryList.addListener(listener);
  }

  return () => {
    if (mediaQueryList.removeEventListener) {
      mediaQueryList.removeEventListener("change", listener);
    } else {
      mediaQueryList.removeListener(listener);
    }
  };
};

const getSnapshot = () => detectCoarsePointer();

const getServerSnapshot = () => false;

export function useTouchDevice() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
