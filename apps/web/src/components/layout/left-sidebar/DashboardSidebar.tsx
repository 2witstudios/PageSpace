"use client";

import { CustomScrollArea } from "@/components/ui/custom-scroll-area";
import Pulse from "./Pulse";
import FavoritesSection from "./FavoritesSection";
import RecentsSection from "./RecentsSection";

export default function DashboardSidebar() {
  return (
    <CustomScrollArea className="flex-1">
      <div className="space-y-6 py-2">
        {/* Pulse - Activity summary */}
        <Pulse />

        {/* Favorites - Pinned drives and pages */}
        <FavoritesSection />

        {/* Recents - Recently viewed pages */}
        <RecentsSection />
      </div>
    </CustomScrollArea>
  );
}
