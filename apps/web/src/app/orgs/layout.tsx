import type { Metadata } from "next";
import OrgsLayoutClient from "./OrgsLayoutClient";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function OrgsLayout({ children }: { children: React.ReactNode }) {
  return <OrgsLayoutClient>{children}</OrgsLayoutClient>;
}
