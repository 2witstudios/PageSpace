"use client";

import { useSyncExternalStore } from "react";

const noop = () => {};

const createSubscription = (query: string) => {
  return (callback: () => void) => {
    if (typeof window === "undefined") {
      return noop;
    }

    const mediaQueryList = window.matchMedia(query);
    const handler = () => callback();

    mediaQueryList.addEventListener("change", handler);

    return () => {
      mediaQueryList.removeEventListener("change", handler);
    };
  };
};

const createSnapshot = (query: string) => () => {
  if (typeof window === "undefined") {
    return false;
  }

  return window.matchMedia(query).matches;
};

const getServerSnapshot = () => false;

export function useBreakpoint(query: string) {
  const subscribe = createSubscription(query);
  const getSnapshot = createSnapshot(query);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
