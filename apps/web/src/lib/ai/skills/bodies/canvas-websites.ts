/**
 * canvas-websites skill body — code-shipped instructions for building
 * websites and interactive pages on CANVAS pages. Loaded on demand via
 * load_skill / the /canvas-websites chip; keep in sync with the renderer
 * and publish pipeline it describes.
 */
export const CANVAS_WEBSITES_SKILL_BODY = `You are building on a CANVAS page: raw HTML/CSS/JS stored as the page's content, rendered in a sandboxed iframe inside the app, and publishable as a standalone website at \`https://<subdomain>.pagespace.site\`.

## What a Canvas page is

- The page content IS the HTML. A shared renderer wraps it in a generated document — doctype, \`<head>\` (charset, viewport, title, CSP), a baseline reset (\`html,body{margin:0;padding:0}\`), then your markup inside a real \`<body>\`. The in-app iframe and the published page render from the same document, so what you see in-app is what publishes.
- Write a body FRAGMENT, not a full document. If you write your own \`<html>\`/\`<head>\`/\`<body>\`, the wrapper is unwrapped: only the body content and any \`<style>\` blocks survive. SEO/OG meta from a hand-written \`<head>\` is honored at publish time (see Publishing), but in-app everything else in that head is discarded.
- \`<style>\` blocks anywhere in your HTML are extracted, sanitized, and hoisted into the generated \`<head>\`, after the baseline reset — your \`html\`/\`body\` rules still win.
- \`<script>\` tags are preserved verbatim and execute. Isolation is by origin (the sandbox), not by a script sanitizer — write real interactive JS freely, but inline only (see the sandbox rules).
- Because only the UA margin is reset, full-bleed layouts work: a \`min-height:100vh\` section reaches the edges with no 8px gap.

## The sandbox and what it blocks

In-app, the canvas renders in an iframe with \`sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"\` — never \`allow-same-origin\`. Your document is an opaque origin, walled off from the logged-in app session. Consequences:

- No PageSpace cookies or session. \`fetch()\` to app APIs will not be authenticated — and is blocked by CSP anyway.
- Treat \`localStorage\`/\`sessionStorage\` as unavailable; keep state in JS variables in memory.
- No DOM access to the parent app; the only channel is \`postMessage\` (used by the theme bridge below).
- In-app, a \`<base target="_blank">\` is injected: every link without an explicit \`target\` opens in a new browser tab. Published pages have no base tag — links navigate normally.

Both contexts also carry this CSP: \`default-src 'none'; img-src data: https:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'\` (form-action/connect-src widen only on published pages with wired forms). In practice:

- Inline \`<script>\` runs; \`<script src="https://cdn...">\` is BLOCKED (\`script-src\` has no https: source). No CDN frameworks — write vanilla JS.
- External stylesheets are blocked EXCEPT Google Fonts: a \`<link>\` to \`fonts.googleapis.com\` plus font files from \`fonts.gstatic.com\` are explicitly allowlisted.
- \`<img src="https://...">\` and \`data:\` images are allowed by CSP — but the CSS sanitizer rewrites any external \`url()\` in CSS to \`url("")\`, so \`background-image: url(https://...)\` dies even though \`<img>\` works. In CSS, use \`data:\` URIs (image/* and font/* MIME types only). The sanitizer also strips \`@import\`, \`expression()\`, \`javascript:\`, \`behavior:\`, and \`data:text/html\`.
- \`fetch()\`/XHR to anything is blocked (no \`connect-src\`), except the wired-form submit endpoint on published pages.

DO: \`<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">\`, \`<img src="https://example.com/photo.jpg">\`, inline \`<script>\` for all interactivity.
DON'T: \`<script src="https://cdn.jsdelivr.net/npm/react"></script>\`, \`fetch('https://api.example.com/...')\`, \`background: url(https://example.com/bg.jpg)\`.

## Dark/light theming

A theme bridge script is auto-injected in BOTH contexts — never write your own. It toggles a \`dark\` class on \`<html>\`: in-app it follows the user's PageSpace theme (the app posts \`{ type: 'pagespace-theme', isDark: boolean }\` into the frame, and the bridge requests the current theme on load); on the published page it follows the OS \`prefers-color-scheme\`, live-updating on change.

Style both modes with CSS variables keyed on that class:

\`\`\`css
:root { --bg: #ffffff; --fg: #111111; }
.dark { --bg: #0b0b10; --fg: #ededed; }
body { background: var(--bg); color: var(--fg); }
\`\`\`

If your JS needs the theme, read \`document.documentElement.classList.contains('dark')\` and watch for changes with a MutationObserver on the \`class\` attribute.

DO: define every color as a variable with a \`.dark\` override.
DON'T: hardcode a single scheme, use your own \`prefers-color-scheme\` media queries for colors (in-app the app theme overrides the OS), or hand-roll a postMessage listener.

## Linking between pages

Write links to other PageSpace pages as in-app dashboard paths:

- Another page: \`/dashboard/{driveId}/{pageId}\`
- These work in-app (opening the target page in a new tab, via the injected base target) AND at publish time they are rewritten to the target's public URL: \`https://<subdomain>.pagespace.site/<slug>\`, or \`/\` when the target is the drive's home page.
- Only pages published in the SAME drive get rewritten. An unpublished or out-of-drive link is left unchanged — a dead app URL on the public site. Publish every page you link to.
- Longer paths (\`/dashboard/{d}/{p}/edit\` etc.) are never treated as inter-page links; only the plain form and the \`/view\` form are.
- External links: ordinary absolute \`https://\` URLs.

DO: \`<a href="/dashboard/abc123/def456">Pricing</a>\`
DON'T: hardcode \`https://mysite.pagespace.site/pricing\` for an in-drive link (breaks in-app, and breaks if the slug or subdomain changes) or link to a page you don't intend to publish.

## Embedding images and files from FILE pages

For an uploaded file (a FILE page) — image, PDF, anything — reference it as:

\`\`\`html
<img src="/dashboard/{driveId}/{filePageId}/view" alt="...">
\`\`\`

Never use \`/api/files/...\` URLs. The \`/dashboard/{driveId}/{pageId}/view\` form is the one convention that works everywhere:

- In-app, the app shell detects these refs and swaps them for tokenized URLs the sandboxed iframe (which has no session) can actually load.
- At publish, each referenced file is copied to a public CDN and the URL rewritten to it. The CDN host is also allowlisted through the CSS sanitizer, so a published CSS \`background-image: url(/dashboard/.../view)\` survives.
- The same \`/view\` URL also works as a plain \`<a href>\` link to the file.
- Anything you embed this way becomes PUBLIC when the page is published — don't embed files that shouldn't be.

## Forms (waitlist, contact, signup)

For any form that should collect submissions, call the \`provision_form_target\` tool FIRST, with the target Sheet page id and an ordered field list (\`name\`, \`label\`, \`type\`, \`required\`). It writes the Sheet's header row and returns \`formHtml\` — embed it into the canvas VERBATIM.

- Do NOT modify the hidden honeypot input (\`_hp\`) or the \`fetch()\`-based submit script inside \`formHtml\`. The honeypot is deliberately off-screen via inline styles; a filled honeypot silently drops the submission. The fetch submit avoids navigating to a raw JSON response.
- The embedded submit token is safe to publish — it authorizes ONLY appending rows to that one Sheet, nothing else.
- A hand-written \`<form>\` will NOT submit until a human wires it in the Canvas page's Forms settings tab — there is no tool for that step. If you do hand-write one, give every input a real \`name\` attribute: the tab derives the field list from your markup.
- The field set is FIXED at wire time. Change the inputs before wiring; afterwards, the only path is delete-and-rewire.
- One canvas can host many forms, but each Sheet accepts only one active form.
- Submission works on the PUBLISHED page (publish scopes the CSP to the forms endpoint). The in-app preview keeps \`form-action 'none'\` — test submissions on the published URL, not in-app.
- Optional: an element with \`data-role="form-status"\` inside the form shows submit status messages.

DO: provision first, paste \`formHtml\` unchanged, style it via CSS around/atop it.
DON'T: rewrite the form's script "more cleanly", remove or label \`_hp\`, or promise a hand-written form works without human wiring.

## Multi-page site structure

A published drive is one site on one subdomain: the drive's home page at \`/\`, every other published canvas at \`/<slug>\`.

- Organize site pages as a parent canvas (home / nav hub) with child canvas pages per section — any page can nest under any page.
- There is no shared template or include mechanism: repeat your \`<nav>\` block (of \`/dashboard/...\` links) on each page; publish rewrites the links per page.
- Keep each canvas focused — one screen, one job; use the home canvas as the navigation hub.

## Publishing

Publishing renders the canvas to a standalone HTML artifact served at \`https://<subdomain>.pagespace.site/<path>\`:

- The subdomain belongs to the drive (allocated from the drive slug, or explicitly chosen). The path is slugified from the page title unless overridden. The drive home page is also served at the site root.
- The published head gets full SEO/social treatment: canonical URL, meta description (derived from the page's first text when not set), robots (default \`index, follow\`; a noindex option exists), Open Graph, Twitter Card, and JSON-LD tags.
- You can control that meta from the canvas itself: a \`<title>\`, \`<meta name="description">\`, \`<meta property="og:title|og:description|og:image">\`, or \`<link rel="icon">\` you write in the HTML is extracted at publish and hoisted into the head, winning over UI-set fallbacks.
- The artifact is a snapshot rendered at publish time — republish after content edits to update the live site.

## Common pitfalls

- DON'T assume CDN libraries, external scripts, or external stylesheets (Google Fonts is the sole styling exception). Everything ships inline.
- DON'T call APIs — no \`fetch\` to PageSpace or anywhere else; the only network write is a wired form's submit on the published page.
- DON'T rely on \`localStorage\`, cookies, or cross-page JS state; each page is standalone and the origin is opaque.
- DON'T use \`/api/files/...\` for file embeds — always \`/dashboard/{driveId}/{filePageId}/view\`.
- DON'T write full \`<html>\` documents expecting the head to render in-app; write fragments and let publish-time extraction handle meta.
- DON'T put external URLs in CSS \`url()\` — they are stripped; use \`data:\` URIs or \`<img>\` elements.
- DON'T edit provisioned \`formHtml\`, and DON'T leave links pointing at pages that won't be published.`;
