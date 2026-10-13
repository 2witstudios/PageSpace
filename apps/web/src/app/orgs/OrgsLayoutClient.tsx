"use client";

import Layout from "@/components/layout/Layout";

/** Org pages render inside the app shell, like Settings. */
export default function OrgsLayoutClient({ children }: { children: React.ReactNode }) {
  return <Layout>{children}</Layout>;
}
