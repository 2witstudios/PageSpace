"use client";

import Layout from "@/components/layout/Layout";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Dashboard route pages return null, so we don't pass children to Layout
  // This ensures CenterPanel renders and GlobalAssistantView stays mounted
  void children;
  return <Layout />;
}

