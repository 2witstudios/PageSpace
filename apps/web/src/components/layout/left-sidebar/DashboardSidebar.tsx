"use client";

import { CustomScrollArea } from "@/components/ui/custom-scroll-area";
import Pulse from "./Pulse";
import FavoritesSection from "./FavoritesSection";
import RecentsSection from "./RecentsSection";

export default function DashboardSidebar() {
  return (
    <CustomScrollArea className="flex-1">
      <div className="space-y-6 py-2">
        {/* Favorites - Pinned drives and pages */}
        <FavoritesSection />

        {/* Pulse - Activity summary */}
        <Pulse />

        {/* Recents - Recently viewed pages */}
        <RecentsSection />
      </div>
    </CustomScrollArea>
  );
}
