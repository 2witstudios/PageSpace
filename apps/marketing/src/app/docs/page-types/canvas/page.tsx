import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Canvas",
  description: "How Canvas pages work in PageSpace — custom HTML, CSS, and JavaScript rendered in an isolated sandbox for dashboards, landing pages, and visual hubs, and publishable to the public web.",
  path: "/docs/page-types/canvas",
  keywords: ["canvas", "HTML", "CSS", "JavaScript", "dashboard", "landing page", "publishing", "sandbox"],
});

const content = `
# Canvas

A Canvas page renders your own HTML, CSS, and JavaScript inside PageSpace. You write the markup in a code editor, flip to a View tab, and the page appears as a fully styled, interactive mini-site sitting in the tree next to your documents and folders — and you can publish it to the public web.

## What you can do

- Create a Canvas page anywhere in the tree from the **+** button or the slash menu, the same way you create a document.
- Switch between **Code** and **View** tabs at the top of the page — Code gives you a Monaco editor, View renders the result.
- Write a full document: HTML with inline \`<style>\` and \`<script>\` for gradients, grid layouts, animations, hover effects, and real interactivity.
- Style with the full set of modern CSS — \`html\`, \`body\`, and \`:root\` selectors, variables, transforms, and animations all behave as they would on any web page.
- Link out with ordinary \`<a href>\` anchors; external links open in a new tab.
- **Publish** a Canvas to the public web at its own address, and **unpublish** it just as easily.
- Open the page's **Version History** to diff or roll back any earlier version.

## How it works

A Canvas page stores one document of HTML, CSS, and JavaScript. When you open the View tab, PageSpace renders it inside a **sandboxed frame** that runs on its own isolated origin, walled off from your logged-in session. Your scripts run — but they can't read your PageSpace cookies, touch other pages, or act as you, and styles can't leak into or out of the rest of the app. It's the same document PageSpace serves when you publish the page, so what you see in View is exactly what a visitor gets.

Saves are optimistic and debounced, and every save carries the revision you started from — if someone else saved in the meantime, your save is rejected as a conflict and your editor re-fetches their version before continuing, instead of silently overwriting it. Readers get a socket event after each save and re-fetch the page, so other viewers see your changes once a save lands, not while you're typing. Every save writes to version history, so you can roll back to any earlier version.

## Publishing

Anyone who can edit the drive can publish a Canvas page to the public web. Hit **Publish** in the canvas header and PageSpace serves a standalone copy at \`https://<your-drive>.pagespace.site/<page>\` — a separate domain from the app, so a public page never has a window into your workspace. Copy the link to share it, re-publish to push your latest saved version, or **Unpublish** to take it down. The Publish control only appears where your deployment has public publishing configured.

## Good to know

- **Your code runs, isolated.** Canvas executes your JavaScript in a sandboxed frame on a throwaway origin — it can't reach your session, your cookies, or any other page. Isolation by origin is what keeps it safe.
- **Published pages live on a separate domain.** Public Canvas pages are served from \`*.pagespace.site\`, never the app's own origin, so putting a page on the web can't expose the workspace it came from.

## Related

- [Pages](/docs/features/pages) — the container every Canvas lives inside, including version history, sharing, and trash behaviour.
- [AI in your Workspace](/docs/features/ai) — how agents can read and rewrite the HTML source of a Canvas page.
- [Sharing & Permissions](/docs/features/sharing) — who can view, edit, and publish a Canvas page.
- [Files & Uploads](/docs/page-types/file) — the right home for images, PDFs, and other binaries that a Canvas can't hold directly.
`;

export default function HowItWorksCanvasPage() {
  return <DocsMarkdown content={content} />;
}
