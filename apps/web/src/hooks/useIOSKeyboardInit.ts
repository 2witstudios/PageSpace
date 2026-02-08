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
        const { Keyboard } = await import("@capacitor/keyboard");

        if (cancelled) return;

        showListener = await Keyboard.addListener(
          "keyboardWillShow",
          (info) => {
            // iPad external keyboard toolbar is typically ~55px tall.
            // Don't shrink the app for it - let the toolbar overlay naturally
            // so the UI extends behind it. Full on-screen keyboards are 300+px.
            const isExternalKeyboardToolbar = info.keyboardHeight < 100;

            if (isExternalKeyboardToolbar) {
              document.body.style.setProperty("--keyboard-height", "0px");
            } else {
              document.body.style.setProperty(
                "--keyboard-height",
                `${info.keyboardHeight}px`
              );
              document.body.classList.add("keyboard-open");
              document.documentElement.classList.add("keyboard-open");
            }
            window.scrollTo(0, 0);
          }
        );

        hideListener = await Keyboard.addListener(
          "keyboardWillHide",
          () => {
            document.body.style.setProperty("--keyboard-height", "0px");
            document.body.classList.remove("keyboard-open");
            document.documentElement.classList.remove("keyboard-open");
            window.scrollTo(0, 0);
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
