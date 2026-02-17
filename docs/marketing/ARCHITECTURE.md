# Marketing Site Architecture

> **Last Updated**: 2026-02-13T09:04:00Z

## Overview

The marketing site is a separate Next.js 15 App Router application (`apps/marketing`) optimized for SEO and fast loading. It is decoupled from the heavy web app (`apps/web`) to ensure fast initial load times and proper search engine indexing.

## Technical Stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 15.3.9 (App Router) |
| Styling | Tailwind CSS 4 + shadcn/ui |
| Animation | tw-animate-css |
| Fonts | Geist Sans + Geist Mono |
| Video | Remotion (planned) |
| Theme | next-themes (light/dark) |
| Deployment | To be determined |

## Directory Structure

```
apps/marketing/
├── src/
│   ├── app/
│   │   ├── page.tsx              # Landing page (to be built)
│   │   ├── layout.tsx            # Root layout with metadata
│   │   ├── pricing/page.tsx      # Pricing (planned)
│   │   ├── downloads/page.tsx    # Downloads hub (planned)
│   │   ├── blog/                 # Blog (planned)
│   │   ├── docs/                 # Developer docs (planned)
│   │   └── ...
│   ├── components/               # Shared components
│   └── lib/                      # Utilities
├── public/
│   ├── robots.txt                # (to be created)
│   └── ...
├── remotion/                     # Video compositions (planned)
├── next.config.ts
├── tailwind.config.ts (implicit via postcss)
└── package.json
```

## Routing Strategy

| Route | Rendering | Revalidation |
|-------|-----------|--------------|
| `/` | SSG | Build time |
| `/pricing` | SSG | Build time |
| `/downloads` | SSG | Build time |
| `/blog` | SSG | Build time |
| `/blog/[slug]` | ISR | 1 hour |
| `/docs` | SSG | Build time |
| `/docs/[...slug]` | SSG | Build time |
| `/changelog` | ISR | 1 hour |

## SEO Strategy

1. **Sitemap**: Generated at build time via `src/app/sitemap.ts`
2. **robots.txt**: Static file in `public/`
3. **Metadata**: Per-page metadata exports
4. **Schema.org**: JSON-LD in layout/pages
5. **Open Graph**: Images + Twitter cards

## Auth Integration

The marketing site shares authentication with the web app:
- Login/signup forms POST to web app API
- Session cookies shared via domain configuration
- Google One Tap prompt on marketing pages
- Redirect to app after successful auth

## Development

```bash
# Run marketing site
pnpm --filter marketing dev

# Build
pnpm --filter marketing build

# Access
http://localhost:3004
```

## Deployment

To be determined. Options:
- Same Vercel project with path rewrite
- Separate deployment with CDN
- Docker container on Mac Studio

## ADRs

See `docs/marketing/adr/` for architectural decision records.
