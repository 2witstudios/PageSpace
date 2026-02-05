"use client";

import { CustomScrollArea } from "@/components/ui/custom-scroll-area";
import Pulse from "./Pulse";
import FavoritesSection from "./FavoritesSection";
import RecentsSection from "./RecentsSection";

export default function DashboardSidebar() {
  return (
    <CustomScrollArea className="flex-1">
      <div>
        <FavoritesSection />
        <Pulse />
        <RecentsSection />
      </div>
    </CustomScrollArea>
  );
}
