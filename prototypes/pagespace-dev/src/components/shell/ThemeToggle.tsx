"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

const emptySubscribe = () => () => {};

export default function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  // False during SSR, true after hydration — the icon can't be known on the
  // server (resolvedTheme is undefined there), so it renders client-only.
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );

  const dark = resolvedTheme === "dark";
  return (
    <Button
      variant="ghost"
      size="icon"
      // Stable across SSR and hydration — resolvedTheme is undefined on the server.
      aria-label="Toggle theme"
      onClick={() => setTheme(dark ? "light" : "dark")}
    >
      {mounted && (dark ? <Sun className="size-4" /> : <Moon className="size-4" />)}
    </Button>
  );
}
