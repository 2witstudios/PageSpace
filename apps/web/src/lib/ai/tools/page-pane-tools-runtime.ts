/**
 * Production wiring for the page-pane tool.
 *
 * Exists purely to keep the DB out of `page-pane-tools.ts`: the CLIENT
 * imports the tool name and output type from that module (`useOpenPagePane`),
 * so anything it pulls in ends up in the browser bundle. The deps seam lives
 * there, the Drizzle-backed implementation lives here, and only server code
 * (`ai-tools.ts`) ever imports this file.
 */
import { placePagePaneForConversation } from '@/lib/agent-workspaces/workspace-placement';
import { createPagePaneTools } from './page-pane-tools';

export const pagePaneTools = createPagePaneTools({
  placePagePane: placePagePaneForConversation,
});
