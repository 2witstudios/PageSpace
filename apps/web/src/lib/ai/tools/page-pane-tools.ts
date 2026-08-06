import { tool } from 'ai';
import { z } from 'zod';

export const OPEN_PAGE_PANE_TOOL_NAME = 'open_page_pane';

export const openPagePaneInputSchema = z
  .object({
    /** The page to show — a real pageId from list_pages/create_page/read_page/etc, never a guess. */
    pageId: z.string().min(1),
    /** Display label for the pane header only — never an address. Omit if unknown. */
    title: z.string().min(1).max(200).optional(),
  })
  .strict();

export const openPagePaneOutputSchema = z.object({
  opened: z.literal(true),
  pageId: z.string(),
  title: z.string().optional(),
});

export type OpenPagePaneOutput = z.infer<typeof openPagePaneOutputSchema>;

/**
 * The one side effect this tool has beyond its ack: place the pane
 * server-side. Injected so the tool module itself stays free of DB imports —
 * the CLIENT imports {@link OPEN_PAGE_PANE_TOOL_NAME} and
 * {@link OpenPagePaneOutput} from here (`useOpenPagePane`), and pulling the
 * layout runtime in would drag Drizzle into the browser bundle.
 */
export interface PagePaneToolDeps {
  /**
   * Place `pageId` in the pane grid of whatever workspace `conversationId`
   * belongs to. A conversation bound to no workspace is a no-op. Must never
   * throw: a layout failure is not a reason to fail the model's turn.
   */
  placePagePane(input: {
    conversationId: string;
    pageId: string;
    title?: string;
    /** Idempotency key derived from the tool call — a retried call must not place twice. */
    opId: string;
  }): Promise<void>;
}

/**
 * Signals the UI to open (or focus) `pageId` in a pane beside this
 * conversation — the highest-value moment is right after editing a page with
 * the page tools, so the user sees the result without hunting for it in the
 * sidebar.
 *
 * **Two paths, deliberately.** `execute` applies a real `open_conversation`
 * layout verb server-side (epic Phase 3 — placement the blob era could not
 * express: the blob's only writer was client→PUT, so an agent's tool call
 * reached exactly the browsers that happened to be rendering that grid, and
 * nothing else). That write lands in the pane ROWS and broadcasts
 * `workspace:updated`, so the pane appears live in an open grid AND is
 * simply there in a grid opened an hour later. The client reaction
 * (`useOpenPagePane`) is kept as the FAST path — it fires off the streamed
 * tool result without waiting for a socket round-trip — and cannot
 * double-place, because both paths converge on "is any pane already showing
 * this page?" first.
 *
 * `execute` still always acks `opened: true` and never waits on the browser:
 * the server cannot know whether any pane actually appeared on screen, and
 * must not claim to. Outside a session's pane grid (a plain conversation),
 * the placement is a no-op and the call is harmless — never a hung turn.
 */
export function createPagePaneTools(deps: PagePaneToolDeps) {
  return {
    open_page_pane: tool({
      description:
        'Open (or focus, if already open) a PageSpace page in a pane beside this conversation, so the user can see your work without ' +
        'hunting for it in the sidebar. Most useful right after reading/editing a page with your page tools. ' +
        'Only has a visible effect inside an agent session with an open pane grid; elsewhere it is a harmless no-op.',
      inputSchema: openPagePaneInputSchema,
      execute: async ({ pageId, title }, options): Promise<OpenPagePaneOutput> => {
        const context = (options as { experimental_context?: { conversationId?: string } } | undefined)
          ?.experimental_context;
        const conversationId = context?.conversationId;
        // `toolCallId` is stable across the SDK's own retries of one call, so
        // deriving the opId from it is what makes a retried placement a
        // replay (the verb engine's op memory short-circuits it) instead of
        // a second pane.
        const toolCallId = (options as { toolCallId?: string } | undefined)?.toolCallId;
        if (conversationId && toolCallId) {
          await deps.placePagePane({
            conversationId,
            pageId,
            title,
            opId: `${OPEN_PAGE_PANE_TOOL_NAME}:${toolCallId}`,
          });
        }
        return { opened: true, pageId, title };
      },
    }),
  };
}
