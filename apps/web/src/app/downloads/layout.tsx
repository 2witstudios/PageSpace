import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Download PageSpace",
  description: "Download PageSpace desktop app for macOS, Windows, and Linux. Native applications with automatic updates and offline support.",
  keywords: ["PageSpace download", "desktop app", "macOS", "Windows", "Linux", "AI workspace download"],
  openGraph: {
    title: "Download PageSpace",
    description: "Download PageSpace desktop app for macOS, Windows, and Linux. Native applications with automatic updates and offline support.",
    url: "https://pagespace.ai/downloads",
  },
  twitter: {
    title: "Download PageSpace",
    description: "Download PageSpace desktop app for macOS, Windows, and Linux. Native applications with automatic updates and offline support.",
  },
  alternates: {
    canonical: "https://pagespace.ai/downloads",
  },
};

export default function DownloadsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
