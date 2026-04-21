import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Pages",
  description: "How pages work in PageSpace — the universal container you create, nest, share, version, export, trash, and restore.",
  path: "/docs/how-it-works/pages",
  keywords: ["pages", "move", "share", "version history", "export", "trash", "restore"],
});

const content = `
# Pages

A page is the one thing everything in PageSpace is made of — documents, folders, spreadsheets, AI chats, uploaded files are all pages. You work with all of them the same way: give it a title, drop it into the tree, share it, version it, export it, trash it.

## What you can do

- Create a page from the **+** button next to a folder in the sidebar, or from the slash menu inside another page.
- Drag a page in the sidebar to reorder it among its siblings or to nest it under a different parent.
- Right-click a page to rename, move, copy, or trash it.
- Select multiple pages and move, copy, or trash them in one action — across drives if you need to.
- Link pages to each other by typing **@** and picking a page; the link follows the page if you rename it later.
- Open a page's **Version History** panel to see every edit, who made it, diff any two points, and roll back a change.
- Download a document as **Markdown** or **.docx**, or a sheet as **.csv** or **.xlsx**.
- Share a page with a specific teammate at view, edit, share, or delete level — separate from their drive access.
- Send a page to the **Trash** view for the drive, then restore it with its children intact.

## How it works

Every page has a title, a type, and a position in a single recursive tree that belongs to one drive. Any page can parent any other page, so a folder can hold an AI chat, a chat can sit next to a sheet, and an uploaded file lands as a child page wherever you drop it. Page types change the editor you get and the toolbar that comes with it, but the container around them is the same.

Editing is real-time and optimistic. Every save carries the revision number you started from, so when two people edit at once the second save sees the first change instead of silently overwriting it. Other viewers see your edits as they happen over the realtime channel.

Moving a page is a change to its parent and its position in the sibling order. The tree blocks loops — you can't drop a page inside one of its own descendants — and keeps the order you dragged. Bulk move and bulk copy can target a different drive, which is how pages travel between workspaces.

Trashing is a soft delete. The page and everything beneath it get marked as trashed, disappear from the main tree, and show up under **Trash** for that drive. Content and parent links are kept. Restoring walks the subtree back into place, and any child that was moved out while the parent was in the trash is returned to where it used to live.

Version history is an activity log of the page's edits. You can scroll it, diff any two entries, and roll back any entry to restore the page to that state. Versions are kept for 30 days by default — older ones are cleaned up in the background.

Permissions resolve from two places at once: your role in the drive the page lives in, plus any per-page grants on this page or an ancestor. Every read, save, and export re-checks them, so changing someone's access takes effect on their next action.

## What it doesn't do

- **No public-link sharing.** Pages live behind workspace sign-in. There is no "anyone with the link" toggle — a URL you paste to someone outside the workspace will bounce them to the login screen and then to a not-found page unless they have a grant or drive membership.
- **Version history isn't kept forever.** By default, page versions older than 30 days are cleaned up and can't be rolled back to.
- **Export is format-specific.** Documents download as Markdown or .docx, sheets as .csv or .xlsx. Canvas, Code, Channel, Task List, and AI Chat pages have no download format — copy the content out, or screenshot the page if you need an artefact.
- **Trash takes the whole subtree.** You can't trash a folder while leaving its children in place. Trash the folder and the children go with it; restore the ones you want back afterwards.
- **Page URLs are IDs, not slugs.** Renaming a page doesn't change its link, and there's no vanity URL to set on a page.
- **A document picks one content mode.** A document page is rich text or Markdown at any given moment — switching between the two is an explicit convert action, not something you flip inline.

## Related

- [Page Types](/docs/page-types) — the nine types a page can be, and what each editor gives you.
- [Drives & Workspaces](/docs/how-it-works/drives) — the container pages live inside, and where drive-level access starts.
- [Sharing & Permissions](/docs/how-it-works/sharing) — how view/edit/share/delete grants combine with drive roles.
- [Files & Uploads](/docs/how-it-works/files) — how uploads become file pages in the tree.
- [AI in your Workspace](/docs/how-it-works/ai) — how agents read and edit pages, and how @mentions pull them into a document.
`;

export default function HowItWorksPagesPage() {
  return <DocsMarkdown content={content} />;
}
