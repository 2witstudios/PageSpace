import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { connection } from 'next/server';
import { notFound } from 'next/navigation';
import { Geist, Geist_Mono } from 'next/font/google';
import { getRequestNonce } from '@/lib/request-nonce';
import { isImagoEnabled } from '@/lib/imago-enabled';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { RealtimeProvider } from '@/realtime/realtime-provider';
import {
  THEME_COOKIE_NAME,
  parseThemePreference,
} from '@/lib/theme/theme-preference';
import { ThemeProvider } from '@/lib/theme/theme-provider';
import './globals.css';
import '../retained-adapters/retained.generated.css';

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
  // The served HTML carries the viewer's theme: data-theme selects
  // color-scheme in globals.css, so the first paint is already right and no
  // script has to correct it.
  const theme = parseThemePreference(
    (await cookies()).get(THEME_COOKIE_NAME)?.value,
  );

  return (
    <html
      lang="en"
      data-theme={theme}
      className={`${sans.variable} ${mono.variable}`}
    >
      <body>
        {/* Set webpack nonce for dynamically loaded chunks (next/dynamic) */}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `__webpack_nonce__ = ${JSON.stringify(nonce)};`,
          }}
        />
        {/* One SWR cache and one realtime socket for the whole app; the shell
            layout never remounts. Every imago page is behind the session
            middleware, so the tab is signed in when the socket connects.
            The theme provider starts from the same cookie as data-theme, so
            the switcher hydrates on the theme the page was served with. */}
        <ImagoSWRProvider>
          <RealtimeProvider>
            <ThemeProvider initialPreference={theme}>{children}</ThemeProvider>
          </RealtimeProvider>
        </ImagoSWRProvider>
      </body>
    </html>
  );
}
