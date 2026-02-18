import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function AccountRedirectPage() {
  redirect("/settings/account");
}
