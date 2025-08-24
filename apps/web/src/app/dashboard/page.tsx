"use client";

import CenterPanel from "@/components/layout/middle-content";
import { useGlobalDriveSocket } from "@/hooks/useGlobalDriveSocket";

export default function Dashboard() {
  // Initialize global drive socket listener for real-time updates
  useGlobalDriveSocket();

  // The Layout component handles authentication and layout rendering
  // We just need to return the center content
  return <CenterPanel />;
}