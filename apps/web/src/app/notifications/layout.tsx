import type { Metadata } from "next";
import NotificationsLayoutClient from "./NotificationsLayoutClient";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function NotificationsLayout({ children }: { children: React.ReactNode }) {
  return <NotificationsLayoutClient>{children}</NotificationsLayoutClient>;
}
