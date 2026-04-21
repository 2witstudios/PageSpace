import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Search — How it Works",
  description: "How search works in PageSpace: the header search box, @-mentions, content matching rules, and what search doesn't cover.",
  path: "/docs/features/search",
  keywords: ["search", "find", "mentions", "autocomplete", "how it works"],
});

const content = `
# Search

Find pages, drives, people, and text across the workspace — from the top bar on every screen, from the \`@\` autocomplete inside documents and channels, and from anything you ask an AI agent.

## What you can do

- Search for a page by title from the top-bar search box on any screen.
- Find a word inside the body of a **Document** page — the page surfaces as a content match.
- Jump to drives you own and people with public profiles.
- Type \`@\` inside a document or channel to pull up a live list of pages and people to link.
- Ask an AI agent in the sidebar to search for something — it can run text, regex, or glob patterns across every drive you've given it access to.

## How it works

The top-bar search box runs every keystroke against three things at once: page titles, drive names, and public user profiles. Document pages also get their body text searched. The mobile magnifying-glass button opens the same search in a dialog.

Every result is filtered through a permission check before you see it. A page you don't have access to never appears, even if it matches perfectly. The same rule applies to the \`@\`-mention picker and to AI-run searches — the search runs against the whole drive, then the results get filtered down to what you (or the agent) can actually open.

Multi-word queries are strict on titles and lenient on bodies. Searching *alpha budget* matches a page called *Project Alpha Budget Q3*, in any word order, but only when every word appears in the title. In document bodies, any single matching word is enough. Ranking is deterministic: exact title match beats title-starts-with, which beats title-contains, which beats body-contains; shorter titles win ties.

The \`@\`-mention picker is a separate, drive-scoped search. When your query is empty it falls back to the most recently updated pages in the current drive, so you can pick recent work without typing. When you do type, it uses the same multi-word title rules as the main box.

AI agents get stronger tools than the search box. Through their sidebar they can pattern-match with regex, glob across page paths in a drive, or sweep every drive you've given them access to in one pass — useful for finding a quote whose exact wording you've half-forgotten.

## Good to know

- **Content search reads Document bodies.** The words inside channel messages, sheet cells, canvas source, code pages, and AI Chat transcripts aren't indexed by the header search — only their titles are. Ask an AI agent for those.
- **The header search covers drives you own.** For pages in drives you're a member of, open that drive's tree or use an AI agent — agents can search across every drive you can see.

## Related

- [Pages](/docs/features/pages) — the Document page type, whose body is the only one the main search reads.
- [Drives & Workspaces](/docs/features/drives) — why owned drives and member drives behave differently in search.
- [AI in your Workspace](/docs/features/ai) — regex, glob, and cross-drive search through an agent.
- [Channels](/docs/page-types/channel) — where \`@\`-mentions are used.
`;

export default function HowItWorksSearchPage() {
  return <DocsMarkdown content={content} />;
}
