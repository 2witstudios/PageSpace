import type { Metadata } from "next";
import DashboardLayoutClient from "./DashboardLayoutClient";
import { getRequestNonce } from "@/lib/request-nonce";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const nonce = await getRequestNonce();

  return <DashboardLayoutClient nonce={nonce}>{children}</DashboardLayoutClient>;
}
