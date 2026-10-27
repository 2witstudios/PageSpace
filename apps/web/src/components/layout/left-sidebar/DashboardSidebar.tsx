"use client";

import { CustomScrollArea } from "@/components/ui/custom-scroll-area";
import FavoritesSection from "./FavoritesSection";
import RecentsSection from "./RecentsSection";

// Pulse used to render here. It now lives in the Home screen itself (the
// signal line above the composer, via useHomeSignals) so it stays visible
// even when this sidebar is collapsed — see the Home Signals Line epic.
export default function DashboardSidebar() {
  return (
    <CustomScrollArea className="flex-1">
      <div className="flex flex-col">
        <FavoritesSection />
        <RecentsSection />
      </div>
    </CustomScrollArea>
  );
}
