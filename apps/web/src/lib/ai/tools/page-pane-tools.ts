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
 * Signals the UI to open (or focus) `pageId` in a pane beside this
 * conversation — the highest-value moment is right after editing a page with
 * the page tools, so the user sees the result without hunting for it in the
 * sidebar.
 *
 * `execute` always acks `opened: true` and returns immediately — the server
 * has no visibility into any browser tab's UI state (a pane grid is
 * client-local, never synced — see `agent-workspace/useAgentWorkspaceStore.ts`),
 * so it cannot know, and must not claim to know, whether any pane actually
 * appeared. The real effect is a CLIENT-SIDE reaction: `useOpenPagePane`
 * watches the conversation's message stream for a completed call to this tool
 * and opens/focuses the pane itself. Outside a session's pane grid (a plain
 * conversation, or no client currently rendering one), the call is a
 * harmless no-op — never a hung turn, because it always resolves here, not
 * client-side.
 */
export const pagePaneTools = {
  open_page_pane: tool({
    description:
      'Open (or focus, if already open) a PageSpace page in a pane beside this conversation, so the user can see your work without ' +
      'hunting for it in the sidebar. Most useful right after reading/editing a page with your page tools. ' +
      'Only has a visible effect inside an agent session with an open pane grid; elsewhere it is a harmless no-op.',
    inputSchema: openPagePaneInputSchema,
    execute: async ({ pageId, title }): Promise<OpenPagePaneOutput> => ({ opened: true, pageId, title }),
  }),
};
