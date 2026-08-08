import { ChatDatabaseProvider } from './ChatDatabaseProvider';
import { SpikeChatHarness } from './SpikeChatHarness';

/**
 * SPIKE (@adobe/data adoption evidence) — evidence route, NOT a product surface.
 *
 * A server component (RSC) rendering the client Database boundary, so the spike
 * exercises the real Next 15 App Router topology: RSC → 'use client' provider →
 * binding component reading `computed` observables. Delete with the spike
 * branch; it is deliberately unlinked from any navigation.
 */
export const metadata = { title: '@adobe/data spike harness' };

export default function AdobeDataSpikePage() {
  return (
    <main>
      <h1>@adobe/data chat-state harness</h1>
      <ChatDatabaseProvider>
        <SpikeChatHarness />
      </ChatDatabaseProvider>
    </main>
  );
}
