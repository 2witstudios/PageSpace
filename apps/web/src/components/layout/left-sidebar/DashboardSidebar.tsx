"use client";

import { CustomScrollArea } from "@/components/ui/custom-scroll-area";
import FavoritesSection from "./FavoritesSection";
import RecentsSection from "./RecentsSection";

export default function DashboardSidebar() {
  return (
    <CustomScrollArea className="flex-1">
      <div>
        <FavoritesSection />
        <RecentsSection />
      </div>
    </CustomScrollArea>
  );
}
