import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Folders — How it Works",
  description: "How folders work in PageSpace — containers in the page tree with no editor of their own. Covers nesting, drop-to-upload, sibling ordering, and how folder permissions do and don't reach the children inside.",
  path: "/docs/how-it-works/folders",
  keywords: ["folders", "nesting", "tree", "drag and drop", "permissions", "how it works"],
});

const content = `
# Folders

A folder is a page whose only job is to hold other pages. It has no editor — opening one shows the list of its children instead of a text surface.

## What you can do

- Create a folder from the **+** button in the sidebar and pick **Folder** in the dialog that opens.
- Nest a folder inside another folder by dragging it in the sidebar; drag children up and down to set the order siblings appear in.
- Drop one or more files onto a folder in the sidebar and they become child **File** pages at the spot you dropped them.
- Open a folder to see its contents as a list or a grid, sorted by title, type, created date, or last-updated date.

## How it works

A folder is the same kind of page as your documents, sheets, and chats — one row in the drive's page tree, with a parent and a list of children. What makes it a folder is that it has no body: instead of rendering an editor, a folder renders the list of pages that sit under it. Any page type can be a child of a folder, and folders nest inside folders up to 100 levels deep — past that, the tree refuses the move.

Sibling order is stored per-parent. Dragging a page up or down in the sidebar moves it between its neighbours, and the sidebar tree honours that drag order from then on. The folder's own list view ignores it: it sorts by title by default, and the **sort by title / type / updated / created** controls switch the column it sorts on. Sort is per-view and not remembered across sessions.

Dropping files onto a folder creates a File page per file under that folder, in the order you dropped them. Classification, text extraction, and OCR happen in the background, as described in [Files & Uploads](/docs/how-it-works/files). You can keep working — the tree shows each new child as soon as it's stored.

Permissions on a folder apply to the folder page itself. Granting someone view or edit on a folder does not walk down to its children — each page checks its own grants plus drive membership. See [Sharing & Permissions](/docs/how-it-works/sharing) for the full resolution rules.

## What it doesn't do

- **A folder share doesn't share what's inside it.** A view or edit grant on a folder lets someone open that folder page and nothing else. To let them read or edit the children, add them to the drive, or grant each child page directly. A teammate who can see the folder but not a child will see a shorter list than you do.
- **A folder has no content of its own.** No body text, no AI chat attached, no version history — the folder records its title, parent, and position among siblings and that's it. If you want a landing page with real writing and links, use a Document.
- **A folder isn't a search or AI boundary.** Global search spans every page you can see in the drive, not the folder you opened. [AI Chat pages](/docs/how-it-works/ai) can be told to read a subtree, but that's a setting on the chat page — not something a folder enforces on the AI agents that walk into it.
- **Folders can't be converted.** A folder stays a folder — there is no action that turns it into a Document, Sheet, or anything else, and no other page type converts into a folder. If you want different content in that slot, move the children out and create the page type you actually want.

## Related

- [Pages](/docs/how-it-works/pages) — the universal container; folders are one of the nine page types.
- [Files & Uploads](/docs/how-it-works/files) — what happens after a dropped file lands as a child File page.
- [Sharing & Permissions](/docs/how-it-works/sharing) — why a grant on a folder doesn't reach the pages inside it.
- [Drives & Workspaces](/docs/how-it-works/drives) — the drive that a folder's tree belongs to.
- [Search](/docs/how-it-works/search) — how results span a drive rather than a single folder.
`;

export default function HowItWorksFoldersPage() {
  return <DocsMarkdown content={content} />;
}
