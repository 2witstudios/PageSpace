'use client';

import { useState, type ReactNode } from 'react';
import { DatabaseProvider } from '@adobe/data-react';
import { createChatDatabase } from '@/state/chat/createChatDatabase';
import { chatStatePlugin } from '@/state/chat/chat-state-plugin';

/**
 * SPIKE (@adobe/data adoption evidence) — React binding harness, container half.
 *
 * `useState(initializer)` (not a module singleton, not `useMemo`) is what makes
 * this safe under React 19 StrictMode: the initializer may run twice in
 * development, but only the first result is retained, so exactly one Database
 * survives per mount and a discarded double-invocation cannot leak observers.
 * A module-level singleton would instead be shared across every request on the
 * server, which is a cross-tenant state leak — the reason the container is
 * created here, inside the client boundary, rather than at import time.
 */
export const ChatDatabaseProvider = ({ children }: { children: ReactNode }) => {
  const [handle] = useState(createChatDatabase);
  return (
    <DatabaseProvider plugin={chatStatePlugin} database={handle.db}>
      {children}
    </DatabaseProvider>
  );
};
