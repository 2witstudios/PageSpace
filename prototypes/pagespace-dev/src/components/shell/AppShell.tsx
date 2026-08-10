"use client";

import { useEffect, useState } from "react";
import LeftRail from "./LeftRail";
import TopBar from "./TopBar";
import SpawnDialog from "@/components/spawn/SpawnDialog";

/**
 * The app frame: glass left rail beside a routed content pane, with the spawn
 * dialog mounted once at the top so ⌘K works from anywhere.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const [spawnOpen, setSpawnOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSpawnOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-dvh overflow-hidden">
      <LeftRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onSpawn={() => setSpawnOpen(true)} />
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
      <SpawnDialog open={spawnOpen} onOpenChange={setSpawnOpen} />
    </div>
  );
}
