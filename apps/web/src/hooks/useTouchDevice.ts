"use client";

import { useSyncExternalStore } from "react";

/**
 * Detects if the current device is a touch device.
 * Uses coarse pointer detection which is more reliable than touch event checks.
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

const getSnapshot = () => {
  if (typeof window === "undefined") {
    return false;
  }
  return window.matchMedia(TOUCH_QUERY).matches;
};

const getServerSnapshot = () => false;

export function useTouchDevice() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
