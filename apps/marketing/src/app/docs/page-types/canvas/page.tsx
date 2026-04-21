import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Canvas",
  description: "How Canvas pages work in PageSpace — custom HTML and CSS rendered in an isolated shadow-DOM sandbox for dashboards, landing pages, and visual hubs.",
  path: "/docs/page-types/canvas",
  keywords: ["canvas", "HTML", "CSS", "dashboard", "landing page", "shadow DOM", "sandbox"],
});

const content = `
# Canvas

A Canvas page renders your own HTML and CSS inside PageSpace. You write the markup in a code editor, flip to a View tab, and the page appears as a fully styled mini-site sitting in the tree next to your documents and folders.

## What you can do

- Create a Canvas page anywhere in the tree from the **+** button or the slash menu, the same way you create a document.
- Switch between **Code** and **View** tabs at the top of the page — Code gives you a Monaco HTML editor, View renders the result.
- Paste in a block of HTML with an inline \`<style>\` tag and get a formatted page with gradients, grid layouts, animations, and hover effects.
- Use the \`html\`, \`body\`, and \`:root\` selectors in your CSS as if you were styling a real web page — Canvas maps them onto its own root so your styles apply cleanly.
- Link to another page in your drive by pointing an \`<a href>\` or a \`data-href\` attribute at a \`/dashboard/<drive>/<pageId>\` URL — clicks stay inside PageSpace and the router takes over.
- Link to any external site from an \`<a href="https://...">\` — clicks prompt a confirmation before opening.
- Make buttons and cards clickable without an anchor by adding \`data-href\` or \`data-navigate\` — Canvas wires a click handler to them.
- Use inline \`data:image/...\` URIs for images and \`data:font/...\` URIs for custom fonts so your Canvas renders with no external dependencies.
- Open the page's **Version History** to diff or roll back any earlier version of the HTML.

## How it works

A Canvas page stores one string of HTML. When you open the View tab, PageSpace extracts any \`<style>\` tags, runs the remaining markup through a sanitiser, runs the styles through a CSS sanitiser, and mounts the result inside a **Shadow DOM** root on the page. Shadow DOM means your CSS is sealed off from the rest of the PageSpace UI and vice versa — your styles can't leak out and app styles can't leak in. The root element sets \`isolation: isolate\` on top of that, so stacking contexts don't escape either.

The HTML sanitiser strips \`<script>\`, \`<iframe>\`, \`<object>\`, \`<embed>\`, \`<link>\`, and \`<meta>\` tags, and removes inline event-handler attributes like \`onclick\`, \`onerror\`, \`onload\`, and \`onmouseover\`. Whatever is left — divs, spans, headings, lists, images, anchors, buttons, SVG — is what renders.

The CSS sanitiser blocks \`expression()\`, \`javascript:\`, \`vbscript:\`, \`-moz-binding\`, \`behavior\`, and \`data:text/html\`. It also rewrites every \`url(...)\` reference: anything that isn't a \`data:\` URI is stripped, and \`data:\` URIs are only kept when their MIME type starts with \`image/\` or \`font/\`. External \`@import\` rules are removed. Gradients, CSS variables, animations, transforms, and the full set of modern CSS properties pass through.

Because Shadow DOM doesn't have an \`html\` or \`body\` element, PageSpace rewrites selectors like \`html\`, \`body\`, \`html body\`, and \`:root\` onto the internal root element of the sandbox before injecting them, so your styles still apply.

Clicks inside a Canvas are caught at the shadow root. Anchors and elements with \`data-href\` or \`data-navigate\` trigger an in-app navigation handler: URLs that match a \`/dashboard/<drive>/<pageId>\` pattern run a permission check and then route inside the app, other same-origin paths route straight through, and anything starting with \`http://\` or \`https://\` prompts a confirmation before opening externally.

Saves are optimistic and debounced, and every save carries the revision you started from — if someone else saved in the meantime, your save is rejected as a conflict and your editor re-fetches their version before continuing, instead of silently overwriting it. Readers get a socket event after each save and re-fetch the HTML, so other viewers see your changes once a save lands, not while you're typing. Every save writes to version history, so you can roll back to any earlier HTML.

## Good to know

- **No JavaScript runs.** \`<script>\` tags and inline event handlers (\`onclick\`, \`onerror\`, and the rest) are stripped for sandbox safety. CSS \`:hover\` and the built-in click-to-navigate behaviour are all the interactivity a Canvas gets.
- **No external stylesheets or network assets.** \`<link>\`, external \`@import\`, and any non-\`data:\` \`url(...)\` reference is removed. Inline assets with \`data:\` URIs — image or font MIME types only.

## Related

- [Pages](/docs/features/pages) — the container every Canvas lives inside, including version history, sharing, and trash behaviour.
- [AI in your Workspace](/docs/features/ai) — how agents can read and rewrite the HTML source of a Canvas page.
- [Sharing & Permissions](/docs/features/sharing) — who can view or edit a Canvas, and how in-page links check permissions before navigating.
- [Files & Uploads](/docs/page-types/file) — the right home for images, PDFs, and other binaries that a Canvas can't hold directly.
`;

export default function HowItWorksCanvasPage() {
  return <DocsMarkdown content={content} />;
}
