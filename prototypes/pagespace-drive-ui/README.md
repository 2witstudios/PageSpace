# PageSpace Support — `@pagespace/sdk` demo

A support site built entirely on PageSpace, showing "PageSpace is the backend your app runs on":

- **Ask** — a public chat bot that streams from a PageSpace agent over the OpenAI-compatible completions endpoint (`/api/v1/chat/completions`, `model: ps-agent://<id>`).
- **Docs** — the drive's documentation, browsable and searchable, rendered as clean pages via `@pagespace/sdk` (`pages.list`, `pages.read`, `search.regex`).
- **Manage** — for owners/admins of the drive: edit the pages that are the bot's "memory," via the SDK (`pages.read` / `replaceLines` / `create` / `trash`). Hidden for non-admins.

The chat uses the endpoint; everything else uses the SDK. That split is the point.

## Run

```bash
bun install
cp .env.example .env.local   # then paste a token (see below)
bun run dev                  # http://localhost:5184
```

Mint a token from the CLI (an **inherit** key — the chat endpoint requires edit access, so a `--role member` key would 403):

```bash
pagespace keys create --drive <driveId> --name support-demo --show-token
```

Put it in `.env.local` as `VITE_PAGESPACE_TOKEN`, or paste it in the app's connect screen. The **Manage** tab appears only when your drive role is OWNER/ADMIN.

The dev server proxies `/api` to `https://pagespace.ai` (the API sends no CORS headers). A real deployment needs a same-origin reverse proxy, and the public chat should be **proxied server-side with rate limiting** — the endpoint has none natively.

## Design

Styling matches the PageSpace product: Tailwind v4 with the design tokens copied from `apps/web/src/app/globals.css`, and small shadcn-style primitives in `src/components/ui.tsx`.
