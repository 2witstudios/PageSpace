"use client";

import { useGlobalDriveSocket } from "@/hooks/useGlobalDriveSocket";

export default function Dashboard() {
  // Initialize global drive socket listener for real-time updates
  useGlobalDriveSocket();

  // Layout always renders CenterPanel - route pages return null for seamless navigation
  return null;
}
