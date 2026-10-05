import type { Metadata } from 'next';
import { connection } from 'next/server';
import { notFound } from 'next/navigation';
import { Geist, Geist_Mono } from 'next/font/google';
import { getRequestNonce } from '@/lib/request-nonce';
import { isImagoEnabled } from '@/lib/imago-enabled';
import { ImagoSWRProvider } from '@/api/swr-provider';

// Self-hosted by next/font: served same-origin, so the CSP needs no font host.
const sans = Geist({
  variable: '--font-face-sans',
  subsets: ['latin'],
  display: 'swap',
});

const mono = Geist_Mono({
  variable: '--font-face-mono',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: { default: 'Imago', template: '%s · Imago' },
  robots: { index: false, follow: false },
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // The nonce CSP needs dynamic rendering: a page prerendered at build time
  // carries no request nonce, and the CSP would block every framework script.
  await connection();
  // Middleware answers 404 while imago is off, but router prefetches skip
  // middleware (see its matcher); this keeps every page behind the flag too.
  if (!isImagoEnabled()) notFound();
  const nonce = await getRequestNonce();

  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        {/* Set webpack nonce for dynamically loaded chunks (next/dynamic) */}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `__webpack_nonce__ = ${JSON.stringify(nonce)};`,
          }}
        />
        {/* One SWR cache for the whole app; the shell layout never remounts. */}
        <ImagoSWRProvider>{children}</ImagoSWRProvider>
      </body>
    </html>
  );
}
