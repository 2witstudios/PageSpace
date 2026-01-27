"use client";

import { useEffect } from "react";
import { isCapacitorApp, isIOS } from "@/lib/capacitor-bridge";

/**
 * Initialize Capacitor Keyboard listeners on iOS.
 * Sets --keyboard-height CSS variable and keyboard-open class on body,
 * which globals.css uses to shrink --app-height when the keyboard opens.
 */
export function useIOSKeyboardInit(): void {
  useEffect(() => {
    if (!isCapacitorApp() || !isIOS()) return;

    document.documentElement.classList.add("capacitor-ios");

    let showListener: { remove: () => Promise<void> } | null = null;
    let hideListener: { remove: () => Promise<void> } | null = null;
    let cancelled = false;

    (async () => {
      try {
        const { Keyboard } = await import(
          /* webpackIgnore: true */ "@capacitor/keyboard"
        );

        if (cancelled) return;

        showListener = await Keyboard.addListener(
          "keyboardWillShow",
          (info) => {
            document.body.style.setProperty(
              "--keyboard-height",
              `${info.keyboardHeight}px`
            );
            document.body.classList.add("keyboard-open");
          }
        );

        hideListener = await Keyboard.addListener(
          "keyboardWillHide",
          () => {
            document.body.style.setProperty("--keyboard-height", "0px");
            document.body.classList.remove("keyboard-open");
          }
        );
      } catch (error) {
        console.warn("[iOS Keyboard] Failed to initialize listeners:", error);
      }
    })();

    return () => {
      cancelled = true;
      showListener?.remove();
      hideListener?.remove();
    };
  }, []);
}
