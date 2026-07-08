import type { Metadata } from "next";
import { headers } from "next/headers";
import DashboardLayoutClient from "./DashboardLayoutClient";
import { NONCE_HEADER } from "@/middleware/security-headers";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  const nonce = requestHeaders.get(NONCE_HEADER) ?? undefined;

  return <DashboardLayoutClient nonce={nonce}>{children}</DashboardLayoutClient>;
}
