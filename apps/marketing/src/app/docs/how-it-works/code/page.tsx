import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Code",
  description: "How Code pages work in PageSpace — a Monaco-powered editor for snippets, configs, and scripts, with syntax highlighting, version history, and honest limits.",
  path: "/docs/how-it-works/code",
  keywords: ["code", "Monaco", "syntax highlighting", "editor", "snippet", "languages"],
});

const content = `
# Code

A Code page is a dedicated editor for code and other plain-text formats. It uses Monaco — the same editor that powers VS Code — so you get syntax highlighting, bracket matching, folding, a minimap, and the keyboard shortcuts your fingers already know.

## What you can do

- Create a Code page from the **+** button in the sidebar or from the slash menu inside another page; pick **Code** as the type.
- Write, paste, and edit code with Monaco's editing surface — multi-cursor, column selection, bracket matching, code folding, and a minimap are all on by default.
- Pick a language from the toolbar dropdown to set highlighting — 25 options ship in: JavaScript, TypeScript, Python, Go, Rust, Java, C, C++, C#, Ruby, PHP, Swift, Kotlin, SQL, Shell, HTML, CSS, SCSS, JSON, YAML, XML, GraphQL, Markdown, **SudoLang**, and **plain text** if you just want a text buffer.
- Name the page with a file extension like \`deploy.sh\` or \`parser.ts\` and the language is detected for you; change it any time from the dropdown.
- Save with **Cmd/Ctrl + S** for an immediate write, or keep typing and let autosave handle it — the page also saves on its own when the window loses focus.
- Open the page's **Version History** panel to see past saves, diff any two points, and roll back.
- Share a Code page to a specific teammate at view, edit, share, or delete level, separate from their drive access; viewers without edit rights see a read-only banner.
- Ask a workspace AI agent to drop a script into your tree — Code is one of the page types agents can create for you.

## How it works

The editor is Monaco running in your browser. The toolbar language dropdown picks which tokenizer highlights your file. If you name the page with a known extension — \`.ts\`, \`.py\`, \`.go\`, \`.rs\`, \`.sh\`, and so on — the language is preselected for you from that extension. You can always override it. SudoLang, a pseudocode language for writing structured AI prompts, ships with a custom tokenizer so prompt specs render the way they're supposed to.

Your theme follows the workspace — the editor reads the same background, foreground, and accent colors as the rest of the app, so switching between light and dark modes carries the editor with it.

Saving is debounced: as you type, your changes are queued and written shortly after you stop. Hitting **Cmd/Ctrl + S** flushes immediately, and so does switching to another window. Every save carries the revision it started from, so if two people save at once the second save notices the first, refetches, and retries instead of silently overwriting. Other people looking at the page see your saved content refresh as you write, unless they're actively editing themselves.

Every save becomes an entry in version history. You can scroll the history, diff any two points, and roll back to any earlier version. Version entries are retained for 30 days by default; older ones are cleaned up in the background.

Permissions resolve from the drive role plus any per-page grants on this Code page or an ancestor. Every read and save re-checks them, so dropping someone's edit rights takes effect on their next save.

## What it doesn't do

- **It doesn't run your code.** There's no Run button, no REPL, no terminal, no output pane — a Code page is an editor, not an execution environment. To run something, copy it out to your own machine.
- **No debugger, no language server.** You get syntax highlighting and bracket matching, not type-checking, not go-to-definition across files, not red squiggles from a real compiler. Monaco looks like VS Code; it doesn't have VS Code's extensions.
- **No live co-editing with shared cursors.** Two people editing the same Code page at the same time won't see each other's cursors, selections, or unsaved keystrokes. Simultaneous saves resolve by revision — the later save refetches and retries — so whoever saves second effectively wins after a brief reconcile. Plan around it for hot-path edits.
- **You can't download a Code page.** Documents export as Markdown or .docx, sheets as .csv or .xlsx — Code pages have no export format. To get the file off PageSpace, copy the contents out of the editor.
- **Fixed language list.** The 25 languages above are what ships. You can't register your own grammar, install a Monaco extension, or upload a custom theme beyond the built-in light/dark.
- **No git.** There are no commits, branches, pull requests, or remote-repo diffs. Version history is PageSpace's own timeline, not a git log.
- **No file-on-disk import.** Dragging a file into the sidebar creates a **File** page, not a Code page — the File page viewer will syntax-highlight the contents, but it isn't editable the way a Code page is. To move code into a Code page, create one and paste.

## Related

- [Pages](/docs/how-it-works/pages) — the container every Code page lives in, including how version history, trash, and permissions work across page types.
- [Files & Uploads](/docs/how-it-works/files) — the difference between a Code page and an uploaded code file, and when each one is the right home.
- [AI in your Workspace](/docs/how-it-works/ai) — how agents create and edit Code pages on your behalf.
- [Sharing & Permissions](/docs/how-it-works/sharing) — controlling who can read or edit a Code page.
`;

export default function HowItWorksCodePage() {
  return <DocsMarkdown content={content} />;
}
