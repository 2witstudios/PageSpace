import type { Metadata } from "next";
import { headers } from "next/headers";
import { connection } from "next/server";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "@/styles/editor-readonly.css";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import ClientTrackingProvider from "@/components/providers/ClientTrackingProvider";
import { Toaster } from "@/components/ui/sonner";
import { NONCE_HEADER } from "@/middleware/security-headers";

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
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'PageSpace',
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
  other: {
    'mobile-web-app-capable': 'yes',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Force dynamic rendering for CSP nonce support
  // Per Next.js 15 requirements: nonces require fresh generation per request
  await connection();

  // Read nonce from middleware headers (Next.js 15 async API)
  const requestHeaders = await headers();
  const nonce = requestHeaders.get(NONCE_HEADER) ?? undefined;

  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {/* Set webpack nonce for dynamically loaded chunks (next/dynamic) */}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `__webpack_nonce__ = ${JSON.stringify(nonce)};`,
          }}
        />
        {/* Register service worker for offline support */}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                if (!('serviceWorker' in navigator)) {
                  return;
                }

                async function unregisterServiceWorkersForDesktop() {
                  try {
                    const registrations = await navigator.serviceWorker.getRegistrations();
                    await Promise.all(
                      registrations.map(function(registration) {
                        return registration.unregister();
                      })
                    );

                    if ('caches' in window) {
                      const cacheNames = await caches.keys();
                      const pagespaceCaches = cacheNames.filter(function(name) {
                        return name.startsWith('pagespace-');
                      });
                      await Promise.all(
                        pagespaceCaches.map(function(name) {
                          return caches.delete(name);
                        })
                      );
                    }
                  } catch (err) {
                    console.log('Desktop mode: failed to clean service workers:', err);
                  }
                }

                function setupServiceWorker() {
                  var isDesktop = !!(window.electron && window.electron.isDesktop);

                  if (isDesktop) {
                    unregisterServiceWorkersForDesktop();
                    return;
                  }

                  navigator.serviceWorker.register('/sw.js').catch(function(err) {
                    console.log('ServiceWorker registration failed:', err);
                  });
                }

                if (document.readyState === 'complete') {
                  setupServiceWorker();
                  return;
                }

                window.addEventListener('load', setupServiceWorker, { once: true });
              })();
            `,
          }}
        />
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
