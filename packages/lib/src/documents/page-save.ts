/**
 * The rules an editor's saves follow, shared by every client of
 * PATCH /api/pages/[pageId]. Pure: no fetch, no store, safe in the browser.
 */

type Waiter<T> = {
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
};

type QueuedSave<T> = {
  content: string;
  send: () => Promise<T>;
  readonly waiters: Waiter<T>[];
};

export type PageSaveSerializer<T> = {
  /**
   * Runs `send` once no other save of this page is out.
   *
   * `send` must read the revision it saves against when it is called, not
   * before: that is what lets a save follow the one ahead of it instead of
   * sending the same revision and being refused by its own predecessor.
   */
  readonly run: (pageId: string, content: string, send: () => Promise<T>) => Promise<T>;
};

/**
 * One save of a page at a time.
 *
 * Saves requested while one is out wait, and only the newest of them is sent:
 * each carries the whole document, so an older one has nothing the newest lacks.
 * A waiter whose text was just saved is answered without sending again, which is
 * what two panes showing one page both saving on blur comes to.
 */
export const createPageSaveSerializer = <T>(): PageSaveSerializer<T> => {
  const busy = new Set<string>();
  const queued = new Map<string, QueuedSave<T>>();

  const drain = (pageId: string, sent: { content: string; succeeded: boolean; result?: T }): void => {
    const next = queued.get(pageId);
    queued.delete(pageId);

    if (!next) {
      busy.delete(pageId);
      return;
    }

    if (sent.succeeded && next.content === sent.content) {
      next.waiters.forEach((waiter) => waiter.resolve(sent.result as T));
      busy.delete(pageId);
      return;
    }

    void start(pageId, next.content, next.send).then(
      (result) => next.waiters.forEach((waiter) => waiter.resolve(result)),
      (error: unknown) => next.waiters.forEach((waiter) => waiter.reject(error))
    );
  };

  const start = async (pageId: string, content: string, send: () => Promise<T>): Promise<T> => {
    busy.add(pageId);
    try {
      const result = await send();
      drain(pageId, { content, succeeded: true, result });
      return result;
    } catch (error) {
      drain(pageId, { content, succeeded: false });
      throw error;
    }
  };

  return {
    run: (pageId, content, send) => {
      if (!busy.has(pageId)) return start(pageId, content, send);

      return new Promise<T>((resolve, reject) => {
        const waiting = queued.get(pageId);
        if (waiting) {
          waiting.content = content;
          waiting.send = send;
          waiting.waiters.push({ resolve, reject });
        } else {
          queued.set(pageId, { content, send, waiters: [{ resolve, reject }] });
        }
      });
    },
  };
};

/**
 * Whether a 409 is this client's own earlier save, and not another writer.
 *
 * A save can commit and still never be answered: the connection drops, or the
 * server fails after the write. The next save is then refused by the save before
 * it. If the server holds the same normalized content in the same mode that
 * this client sent and never heard back about, no unseen edit can be lost.
 */
export const isOwnUnconfirmedSave = (
  storedContent: string | null | undefined,
  unconfirmedContent: string | undefined,
  storedContentMode: string = 'html',
  unconfirmedContentMode: string = 'html'
): boolean =>
  unconfirmedContent !== undefined &&
  storedContent !== undefined &&
  storedContent !== null &&
  storedContentMode === unconfirmedContentMode &&
  normalizeEmptyDocumentContent(storedContent) === normalizeEmptyDocumentContent(unconfirmedContent);

/** The server's canonical form for empty TipTap HTML and JSON documents. */
export const normalizeEmptyDocumentContent = (content: string): string => {
  const trimmed = content.trim();
  if (trimmed === '' || /^<p>(?:\s*|<br>|<br\s*\/>)<\/p>$/.test(trimmed)) return '';
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      typeof parsed === 'object' && parsed !== null &&
      'type' in parsed && parsed.type === 'doc' &&
      'content' in parsed && Array.isArray(parsed.content) && parsed.content.length === 1 &&
      parsed.content[0]?.type === 'paragraph' &&
      (!parsed.content[0].content || parsed.content[0].content.length === 0)
    ) return '';
  } catch {
    // Non-JSON text is already canonical.
  }
  return content;
};
