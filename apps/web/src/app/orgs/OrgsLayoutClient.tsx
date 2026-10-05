"use client";

import { notFound } from "next/navigation";
import { ORGS_ENABLED } from "@pagespace/lib/organizations/orgs-enabled";
import Layout from "@/components/layout/Layout";

/** Org pages render inside the app shell, like Settings. While orgs are dark, every /orgs page is a 404. */
export default function OrgsLayoutClient({ children }: { children: React.ReactNode }) {
  if (!ORGS_ENABLED) notFound();
  return <Layout>{children}</Layout>;
}
