"use client";

import { useEffect, useRef } from "react";

const GOOGLE_GSI_SCRIPT_URL = "https://accounts.google.com/gsi/client";

/**
 * Google One Tap — passive host on the marketing site.
 *
 * Google's script handles everything: it shows a One Tap prompt and,
 * when the user accepts, POSTs the credential directly to the main app's
 * `/api/auth/google/one-tap` endpoint. The marketing site never touches
 * the credential.
 */
export function GoogleOneTap() {
  const initializedRef = useRef(false);

  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://pagespace.ai";
  const enabled = process.env.NEXT_PUBLIC_ENABLE_ONE_TAP === "true";

  useEffect(() => {
    if (!enabled || !clientId || initializedRef.current) return;

    // Skip on mobile / in-app browsers where One Tap has poor support
    if (typeof navigator !== "undefined") {
      const ua = navigator.userAgent;
      const isMobile =
        /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile|tablet/i.test(ua);
      const isInApp =
        /FBAN|FBAV|FB_IAB|Instagram|Twitter|TikTok|Snapchat|Pinterest|LinkedIn/i.test(ua);
      if (isMobile || isInApp) return;
    }

    const loginUri = `${appUrl}/api/auth/google/one-tap`;

    const init = () => {
      if (!window.google?.accounts?.id || initializedRef.current) return;
      initializedRef.current = true;

      window.google.accounts.id.initialize({
        client_id: clientId,
        login_uri: loginUri,
        auto_select: true,
        cancel_on_tap_outside: true,
        context: "signin" as const,
        ux_mode: "redirect",
        use_fedcm_for_prompt: true,
        itp_support: true,
      });

      window.google.accounts.id.prompt();
    };

    // Load or reuse the GSI script
    const existing = document.querySelector(
      `script[src="${GOOGLE_GSI_SCRIPT_URL}"]`
    );

    if (existing) {
      if (window.google?.accounts?.id) {
        init();
      } else {
        existing.addEventListener("load", init);
      }
    } else {
      const script = document.createElement("script");
      script.src = GOOGLE_GSI_SCRIPT_URL;
      script.async = true;
      script.defer = true;
      script.onload = init;
      document.head.appendChild(script);
    }

    return () => {
      if (window.google?.accounts?.id) {
        window.google.accounts.id.cancel();
      }
    };
  }, [enabled, clientId, appUrl]);

  return null;
}
