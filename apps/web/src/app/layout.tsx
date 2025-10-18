import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "@/styles/editor-readonly.css";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import ClientTrackingProvider from "@/components/providers/ClientTrackingProvider";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL('https://pagespace.ai'),
  title: {
    default: "PageSpace - AI-Powered Workspace",
    template: "%s | PageSpace"
  },
  description: "A unified workspace combining documents, collaborative channels, and AI agents. Built for creators, teams, and businesses.",
  keywords: ["workspace", "AI workspace", "collaborative workspace", "team collaboration", "AI agents", "document management"],
  authors: [{ name: "PageSpace" }],
  creator: "PageSpace",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any", type: "image/x-icon" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: 'https://pagespace.ai',
    siteName: 'PageSpace',
  },
  twitter: {
    card: 'summary_large_image',
    creator: '@pagespace',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <ClientTrackingProvider />
          {children}
          <Toaster position="top-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
