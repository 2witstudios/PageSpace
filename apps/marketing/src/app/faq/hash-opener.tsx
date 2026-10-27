"use client";

import { useEffect } from "react";

export function FAQHashOpener() {
  useEffect(() => {
    const openFromHash = () => {
      const hash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
      if (!hash) return;
      const el = document.getElementById(hash);
      if (el instanceof HTMLDetailsElement && !el.open) {
        el.open = true;
        requestAnimationFrame(() => {
          el.scrollIntoView({ block: "start", behavior: "auto" });
        });
      }
    };

    openFromHash();
    window.addEventListener("hashchange", openFromHash);

    const clickHandler = (e: MouseEvent) => {
      const target = e.target as Element | null;
      const anchor = target?.closest?.("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!href.includes("/faq#")) return;
      setTimeout(openFromHash, 0);
    };
    document.addEventListener("click", clickHandler);

    return () => {
      window.removeEventListener("hashchange", openFromHash);
      document.removeEventListener("click", clickHandler);
    };
  }, []);

  return null;
}
