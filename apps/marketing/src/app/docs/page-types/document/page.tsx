import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Documents — How it Works",
  description: "How Document pages work in PageSpace: the rich-text editor, slash menu, bubble toolbar, tables, page @mentions, Rich Text and Markdown modes, and live collaboration.",
  path: "/docs/page-types/document",
  keywords: ["documents", "rich text", "markdown", "tiptap", "editor", "collaboration", "how it works"],
});

const content = `
# Documents

A Document is the page type you reach for when you want to write — notes, specs, briefs, anything prose-shaped. You get a rich-text editor with tables, headings, code blocks, live collaboration, and an @-picker that lets you link to any other page in your workspace as you type.

## What you can do

- Start a Document from the **+** button in the sidebar or the slash menu inside another page — give it a title and begin typing.
- Format text from three places: the **sticky toolbar** at the top of the page, the **bubble toolbar** that appears when you select text, and the **slash menu** that opens on an empty line when you type \`/\`.
- Use headings 1–3, bullet and numbered lists, blockquotes, inline code, bold, italic, strikethrough, and tables.
- Drop a fenced code block and get real syntax highlighting for the language you set.
- Pick a **font family** (Default, Sans, Serif, Mono) and a **font size** (12–32) for the current selection from the toolbar — Rich Text mode only.
- Type **@** to pick another page in the drive; the result is inserted as a live link to that page.
- Switch a Document between **Rich Text** and **Markdown** from the **Page Setup** menu in the header — you're asked to confirm, and a version snapshot is taken before the conversion runs.
- Flip to **Code view** to see and edit the raw HTML or Markdown source, then flip back to keep writing.
- Watch your co-editors' changes stream in as they type; your own edits ship the same way.
- See a live character count in the footer of the editor.
- Save with **Cmd/Ctrl+S**, rely on the 1-second autosave, or trust the automatic save that fires when you switch windows — all three paths go to the same place.
- Export the page as **.docx** or **Markdown**, or use your browser's **Print** dialog.
- Hand a Document to AI — an AI Chat page in the same drive can read it and make targeted edits line by line.
- Turn a Word file you uploaded (.doc or .docx) into a Document you can edit, without losing the original file page.

## How it works

The editor is TipTap under the hood, with a set of extensions wired up for PageSpace — headings, lists, tables, code blocks with Shiki syntax highlighting, the page @mention, and a character counter. None of that shows up as jargon in the UI; you get a toolbar, a bubble on selection, and a slash menu on an empty line.

Every Document stores its content in one of two modes: **Rich Text** (the editor's HTML) or **Markdown**. That choice lives on the page itself, not a user setting, and it decides what the editor hands back when you type and what a Markdown export actually converts from. You switch modes from Page Setup. Before the switch, the page is saved, a version snapshot is written, and the content is translated — HTML to Markdown on the way down, Markdown to HTML on the way up. You confirm the direction because the translation isn't lossless.

Saves are optimistic. Every one of them carries the revision number you started from, so when two people edit at once the second save is rejected rather than silently overwriting the first; the editor refetches and you keep typing from the updated state. As you type, changes are held for one second and then sent; pressing **Cmd/Ctrl+S**, clicking out of the window, or closing the tab all flush whatever's pending. Your co-editors receive the update over the real-time channel and their views catch up without a refresh.

If you don't have edit permission for the page you opened, the editor renders in read-only mode with a banner across the top. Selection still works — you can copy — but every edit path is disabled.

Under the **@** picker, results come from a search across the current drive: pages you can see, users who share the drive. Picking a page drops an inline \`@Title\` link into the text. The link stays pointed at the page even if you later rename it — the link stores the page's ID, not its title.

AI reads a Document by pulling its current content into the conversation, and edits it by replacing specific lines rather than rewriting the whole file from scratch. Because the Document is just a page, an agent can also @-mention it from somewhere else in the workspace to pull it into context.

## Good to know

- **Rich Text and Markdown modes are exclusive.** A Document is one or the other at any moment, and switching is a deliberate **Page Setup** action with a confirm dialog. Font family and size belong to Rich Text and don't survive a round-trip through Markdown.

## Related

- [Pages](/docs/features/pages) — the behaviours every page type shares: move, share, version history, export, trash.
- [AI in your Workspace](/docs/features/ai) — how agents read and edit Documents, and how @-mentioning pulls one into an AI Chat.
- [Files & Uploads](/docs/page-types/file) — why a dropped image becomes a File page in the tree instead of an inline embed, and how to convert a Word file into a Document.
- [Channels](/docs/page-types/channel) — the place to hold a conversation next to a Document rather than inside it.
- [Sharing & Permissions](/docs/features/sharing) — how read-only mode and the edit banner get decided.
`;

export default function HowItWorksDocumentsPage() {
  return <DocsMarkdown content={content} />;
}
