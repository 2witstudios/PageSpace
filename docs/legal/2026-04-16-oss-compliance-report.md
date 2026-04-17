# PageSpace IP & OSS Compliance Report (Fundraise DD)

**Prepared:** 2026-04-16
**Scope:** Entire `2witstudios/pagespace` monorepo
**Branch:** `claude/legal-compliance-report-D8Poy`
**Audience:** Legal / investor due-diligence

This report answers counsel's three IP-DD items:

1. Did anyone other than Jonathan touch the code?
2. If so, is IP assignment required?
3. Full OSS inventory, with copyleft flagged.

A **Founder's Confirmation** memo ready for signature is in §1.

---

## 0. Cleanups landed in this branch

1. **License model flipped to proprietary.** Root `LICENSE` now reads
   "All rights reserved" (copyright Jonathan, d/b/a 2witstudios — sole
   proprietorship). Every workspace `package.json` declares
   `"license": "UNLICENSED"`. Prior state was an inconsistent mix of
   CC-BY-NC-SA-4.0 and template-default AGPL-3.0.
2. **Remotion purged.** Unused offline video-rendering code removed from
   `apps/marketing`. Transitive package count: 2,253 → 2,104.
3. **`THIRD-PARTY-NOTICES.md` created** at the repo root. Records the
   formal license elections (`dompurify` → Apache-2.0; `jszip` → MIT) and
   the LGPL/MPL attributions for the remaining non-permissive components.

---

## 1. Founder's Confirmation (hand this to counsel)

> I, Jonathan [LAST NAME], sole proprietor operating as 2witstudios
> (GitHub: `2witstudios`, email: `2witstudios@gmail.com`), confirm the
> following for the `2witstudios/pagespace` repository as of the HEAD of
> branch `claude/legal-compliance-report-D8Poy` on 2026-04-16:
>
> 1. **Sole author.** All human-authored source code was written by me. The
>    git history shows two author identities — "2Wits" and "2witstudios" —
>    both bound to `2witstudios@gmail.com` and both referring to me.
> 2. **No third-party human contributors.** No outside IP assignments are
>    required.
> 3. **Only automated contributor is Dependabot.** 5 commits, all bumping
>    GitHub Actions versions inside `.github/workflows/`. No product source
>    or `package.json` touched; the bot claims no authorship. See §2.
> 4. **OSS dependency list is complete.** §7 (direct) and §8 (transitive
>    SBOM) are generated programmatically from `pnpm-lock.yaml`.
> 5. **Copyleft posture.** No dependency imposes copyleft obligations on
>    PageSpace's proprietary code. Every non-permissive dependency is
>    either (a) not shipped to production, (b) dual-licensed with a
>    permissive option we formally elect, or (c) used unmodified in a way
>    the license expressly permits. See §4.
>
> Signed: __________________________  Date: __________

---

## 2. Authorship Evidence

### 2.1 Git authors — entire history, all branches

| Commits | Author | Email |
|---:|---|---|
| 80 | 2Wits | 2witstudios@gmail.com |
| 26 | 2witstudios | 2witstudios@gmail.com |
| 5 | dependabot[bot] | 49699333+dependabot[bot]@users.noreply.github.com |

"2Wits" and "2witstudios" share one email — same person, two display-name
variants. Committers are Jonathan (direct pushes) and `GitHub <noreply@github.com>`
(PR squash-merges; authorship remains Jonathan's).

### 2.2 Dependabot scope (all 5 commits)

| SHA | Change |
|---|---|
| `16c7114` | `.github/workflows/security.yml`: bump `trufflesecurity/trufflehog` 3.94.2 → 3.94.3 (#1007) |
| `4564f11` | `.github/workflows/`: bump `softprops/action-gh-release` 2 → 3 (#1005) |
| `251bdd9` | `.github/workflows/security.yml`: bump `trufflesecurity/trufflehog` 3.94.1 → 3.94.2 (#832) |
| `b5d5fca` | `.github/workflows/docker-images.yml`: bump `docker/login-action` 3 → 4 (#815) |
| `1031707` | `.github/workflows/security.yml`: bump `trufflesecurity/trufflehog` 3.93.8 → 3.94.1 (#817) |

Each diff is a single-line version bump in a GitHub Actions YAML file. No
product source, no `package.json`, no authorship claim.

**Conclusion:** Counsel item 1 confirmed; counsel item 2 — no outside-contributor
IP assignments required.

---

## 3. Project's Own License

- **Root `LICENSE`:** proprietary "All Rights Reserved" (copyright
  Jonathan, d/b/a 2witstudios — sole proprietorship).
- **Every workspace `package.json`:** `"license": "UNLICENSED"` (npm/SPDX
  convention for proprietary).

The prior CC-BY-NC-SA-4.0 and stray AGPL-3.0 strings have been removed.

---

## 4. Third-Party Copyleft-Family Dependencies — per-package analysis

Method: `pnpm install --ignore-scripts` (2,104 unique packages), read each
installed `package.json`'s `license` field, flag
`GPL|LGPL|AGPL|MPL|EPL|CDDL|SSPL|OSL|EUPL`. `pnpm why <pkg>` establishes
provenance (direct/transitive, prod/dev/build).

**Bottom line:** no copyleft-family dependency imposes copyleft obligations
on PageSpace's code.

### 4.1 Pure GPL / AGPL / SSPL

**Zero.**

### 4.2 Dual-licensed with a GPL option — elect permissive

| Package | Version | Licenses | Provenance | Election | Impact |
|---|---|---|---|---|---|
| `jszip` | 3.10.1 | MIT **OR** GPL-3.0-or-later | Transitive (web app) via `mammoth`, `html-to-docx`, `docx-preview` | **MIT** (recorded in `THIRD-PARTY-NOTICES.md`) | Zero copyleft. |

### 4.3 LGPL-3.0-or-later — dynamic linking, proprietary-safe

| Package | Version | Provenance |
|---|---|---|
| `@img/sharp-libvips-linux-x64` | 1.0.4, 1.2.3 | Native binary loaded by `sharp` in the processor service |
| `@img/sharp-libvips-linuxmusl-x64` | 1.0.4, 1.2.3 | Same, musl variant |

`sharp` is imported at `apps/processor/src/workers/image-processor.ts` for
image resize/convert/EXIF-rotate. The `libvips` binaries load dynamically
at runtime and are unmodified.

LGPL-3.0 §4 permits this use by proprietary software given (a) the library
license text is provided to recipients and (b) users can swap in a modified
build. Both satisfied via `THIRD-PARTY-NOTICES.md` and `sharp`'s built-in
custom-libvips install path.

**No source disclosure required.**

### 4.4 MPL-2.0 — per-package classification

MPL-2.0 is a per-file copyleft that attaches only to files we modify.
Unmodified use imposes nothing on surrounding code.

| Package | Version | Provenance | Shipped? | Modified? | Obligation |
|---|---|---|---|---|---|
| `dompurify` | 3.2.7 | Direct prod dep in `apps/web`; sanitizes AI tool-call HTML | Yes | No | Dual **MPL-2.0 OR Apache-2.0** — elect Apache-2.0 (recorded in `THIRD-PARTY-NOTICES.md`). MPL removed. |
| `@capgo/capacitor-social-login` | 7.20.0 | Direct prod dep in `apps/ios` + `apps/android`; Apple/Google sign-in | Mobile only | No | Ship LICENSE text in mobile licenses screen. |
| `lightningcss` (+ linux-gnu, linux-musl) | 1.30.1 | Transitive dev-only via `@tailwindcss/postcss` + `vite` | No — build-time | No | None. |
| `axe-core` | 4.10.3 | Transitive dev-only via `eslint-plugin-jsx-a11y` | No — lint-time | No | None. |

**No source disclosure required** for any MPL-2.0 dependency.

### 4.5 Removal cost if counsel wants zero LGPL/MPL

Strong copyleft (GPL, AGPL, SSPL) is what usually triggers DD concern and
is absent from this tree. LGPL-3.0-dynamic and MPL-2.0-unmodified do not
propagate copyleft to PageSpace's code. If counsel nonetheless wants them
gone:

- `dompurify` — solved by the Apache-2.0 election; zero code change.
- `axe-core`, `lightningcss` — dev/build-time transitive; not shipped, no
  removal needed.
- `@capgo/capacitor-social-login` — swap to
  `@capacitor-community/apple-sign-in` + `@codetrix-studio/capacitor-google-auth`
  (both MIT). ~1 day of mobile work.
- `sharp` / `libvips` — replace with `jimp` (MIT, pure JS, ~5× slower) or
  a hosted image API. Not recommended; `sharp` is the industry standard
  and LGPL-3.0-dynamic is a textbook-safe pattern.

---

## 5. Ambiguous Third-Party Licenses — cosmetic only

None affect PageSpace's IP posture.

| Package | Version | License field | Ground truth | Action |
|---|---|---|---|---|
| `@gridland/utils` | 0.2.53 | (missing) | First-party (2witstudios) | Declare a license in that package's repo. |
| `@gridland/web` | 0.2.53 | (missing) | Same. | Same. |
| `argparse` | 2.0.1 | Python-2.0 | PSF License — GPL-compatible permissive. | None. |
| `atomically`, `khroma`, `stubborn-fs` | — | (missing) | Upstream repos are MIT. | Cosmetic metadata gap. |
| `duck` | 0.1.12 | "BSD" | Unspecified BSD — treat as BSD-3-Clause. | None. |

---

## 6. Transitive SBOM — License Distribution

Generated from `pnpm install` against the committed `pnpm-lock.yaml`.

| Count | License |
|---:|---|
| 1,720 | MIT |
| 150 | ISC |
| 107 | Apache-2.0 |
| 43 | BSD-2-Clause |
| 37 | BSD-3-Clause |
| 11 | BlueOak-1.0.0 |
| 5 | MPL-2.0 |
| 5 | UNKNOWN (see §5) |
| 4 | LGPL-3.0-or-later |
| 4 | (MIT OR CC0-1.0) |
| 3 | Unlicense |
| 2 | OFL-1.1 (fonts) |
| 2 | CC-BY-4.0 |
| 2 | (MIT AND Zlib) |
| 2 | 0BSD |
| 2 | MIT AND ISC |
| 1 | MIT-0 |
| 1 | Apache-2.0 AND MIT |
| 1 | Python-2.0 |
| 1 | (MPL-2.0 OR Apache-2.0) |
| 1 | BSD (unspecified) |
| 1 | (BSD-3-Clause AND Apache-2.0) |
| 1 | (AFL-2.1 OR BSD-3-Clause) |
| 1 | (MIT OR GPL-3.0-or-later) |
| 1 | CC0-1.0 |
| 1 | WTFPL OR ISC |
| 1 | WTFPL |
| 1 | (WTFPL OR MIT) |
| — | **Total:** 2,104 unique packages |

---

## 7. Directly-Declared OSS Dependencies (per `package.json`)

Workspace-internal packages (`workspace:*`) omitted.

### package.json  (declared license: UNLICENSED)

**devDependencies** (20)

- `@faker-js/faker` @ `^9.3.0`
- `@testing-library/jest-dom` @ `^6.6.3`
- `@testing-library/react` @ `^16.1.0`
- `@testing-library/user-event` @ `^14.5.2`
- `@types/jest` @ `^30.0.0`
- `@types/node` @ `^24.0.13`
- `@typescript-eslint/typescript-estree` @ `^8.46.0`
- `@vitejs/plugin-react` @ `^4.3.4`
- `@vitest/coverage-v8` @ `^2.1.0`
- `@vitest/ui` @ `^2.1.0`
- `dotenv` @ `^17.2.0`
- `drizzle-kit` @ `^0.23.2`
- `jsdom` @ `^25.0.1`
- `knip` @ `^5.70.2`
- `msw` @ `^2.6.8`
- `tsx` @ `^4.21.0`
- `turbo` @ `^2.5.5`
- `typescript` @ `^5.8.3`
- `vitest` @ `^2.1.0`
- `yaml` @ `^2.8.2`

### apps/android/package.json  (declared license: UNLICENSED)

**dependencies** (10)

- `@capacitor/android` @ `^7.0.3`
- `@capacitor/app` @ `^7.0.3`
- `@capacitor/browser` @ `^7.0.3`
- `@capacitor/core` @ `^7.4.5`
- `@capacitor/keyboard` @ `^7.0.3`
- `@capacitor/preferences` @ `^7.0.3`
- `@capacitor/push-notifications` @ `^7.0.0`
- `@capacitor/splash-screen` @ `^7.0.3`
- `@capacitor/status-bar` @ `^7.0.3`
- `@capgo/capacitor-social-login` @ `^7.20.0`

**devDependencies** (2)

- `@capacitor/cli` @ `^7.0.0`
- `typescript` @ `^5.8.3`

### apps/atlas/package.json  (declared license: UNLICENSED)

**dependencies** (5)

- `@fontsource/ibm-plex-mono` @ `^5.1.1`
- `@fontsource/space-grotesk` @ `^5.1.1`
- `@xyflow/react` @ `^12.10.0`
- `react` @ `^19.1.2`
- `react-dom` @ `^19.1.2`

**devDependencies** (5)

- `@types/react` @ `^19.1.13`
- `@types/react-dom` @ `^19.1.9`
- `@vitejs/plugin-react` @ `^4.3.4`
- `typescript` @ `^5.8.3`
- `vite` @ `^5.4.19`

### apps/control-plane/package.json  (declared license: UNLICENSED)

**dependencies** (7)

- `@paralleldrive/cuid2` @ `^2.2.2`
- `dotenv` @ `^17.2.0`
- `drizzle-orm` @ `^0.32.2`
- `fastify` @ `^5.3.3`
- `fastify-plugin` @ `^5.1.0`
- `postgres` @ `^3.4.5`
- `stripe` @ `^20.1.0`

**devDependencies** (4)

- `drizzle-kit` @ `^0.23.2`
- `tsx` @ `^4.16.2`
- `typescript` @ `^5.8.3`
- `vitest` @ `^2.1.0`

### apps/desktop/package.json  (declared license: UNLICENSED)

**dependencies** (5)

- `electron-store` @ `^10.0.0`
- `electron-updater` @ `^6.6.2`
- `node-machine-id` @ `^1.1.12`
- `ws` @ `^8.18.3`
- `zod` @ `^4.0.16`

**devDependencies** (6)

- `@types/node` @ `^20.17.12`
- `@types/ws` @ `^8.18.1`
- `electron` @ `^33.3.1`
- `electron-builder` @ `^26.0.8`
- `electron-vite` @ `^4.0.1`
- `typescript` @ `^5.8.3`

### apps/ios/package.json  (declared license: UNLICENSED)

**dependencies** (10)

- `@capacitor/app` @ `^7.0.3`
- `@capacitor/browser` @ `^7.0.3`
- `@capacitor/core` @ `^7.4.5`
- `@capacitor/ios` @ `^7.0.3`
- `@capacitor/keyboard` @ `^7.0.3`
- `@capacitor/preferences` @ `^7.0.3`
- `@capacitor/push-notifications` @ `^7.0.0`
- `@capacitor/splash-screen` @ `^7.0.3`
- `@capacitor/status-bar` @ `^7.0.3`
- `@capgo/capacitor-social-login` @ `^7.20.0`

**devDependencies** (2)

- `@capacitor/cli` @ `^7.0.0`
- `typescript` @ `^5.8.3`

### apps/marketing/package.json  (declared license: UNLICENSED)

**dependencies** (39)

- `@base-ui/react` @ `^1.2.0`
- `@hookform/resolvers` @ `^5.2.2`
- `@radix-ui/react-accordion` @ `^1.2.12`
- `@radix-ui/react-avatar` @ `^1.1.10`
- `@radix-ui/react-checkbox` @ `^1.3.3`
- `@radix-ui/react-dialog` @ `^1.1.15`
- `@radix-ui/react-dropdown-menu` @ `^2.1.16`
- `@radix-ui/react-label` @ `^2.1.7`
- `@radix-ui/react-navigation-menu` @ `^1.2.14`
- `@radix-ui/react-scroll-area` @ `^1.2.10`
- `@radix-ui/react-select` @ `^2.2.6`
- `@radix-ui/react-separator` @ `^1.1.7`
- `@radix-ui/react-slot` @ `^1.2.3`
- `@radix-ui/react-tabs` @ `^1.1.13`
- `@radix-ui/react-tooltip` @ `^1.2.8`
- `class-variance-authority` @ `^0.7.1`
- `clsx` @ `^2.1.1`
- `cmdk` @ `^1.1.1`
- `date-fns` @ `^4.1.0`
- `embla-carousel-react` @ `^8.6.0`
- `input-otp` @ `^1.4.2`
- `lucide-react` @ `^0.525.0`
- `motion` @ `^12.23.22`
- `next` @ `15.3.9`
- `next-themes` @ `^0.4.6`
- `radix-ui` @ `^1.4.3`
- `react` @ `^19.1.2`
- `react-day-picker` @ `^9.13.2`
- `react-dom` @ `^19.1.2`
- `react-hook-form` @ `^7.63.0`
- `react-markdown` @ `^10.1.0`
- `react-resizable-panels` @ `^4.6.2`
- `recharts` @ `2.15.4`
- `remark-gfm` @ `^4.0.1`
- `resend` @ `^6.1.2`
- `sonner` @ `^2.0.7`
- `tailwind-merge` @ `^3.3.1`
- `vaul` @ `^1.1.2`
- `zod` @ `^4.1.11`

**devDependencies** (13)

- `@eslint/eslintrc` @ `^3`
- `@playwright/test` @ `^1.49.1`
- `@tailwindcss/postcss` @ `^4`
- `@tailwindcss/typography` @ `^0.5.19`
- `@types/node` @ `^20`
- `@types/react` @ `^19`
- `@types/react-dom` @ `^19`
- `eslint` @ `^9`
- `eslint-config-next` @ `15.3.9`
- `shadcn` @ `^3.8.4`
- `tailwindcss` @ `^4`
- `tw-animate-css` @ `^1.4.0`
- `typescript` @ `^5`

### apps/processor/package.json  (declared license: UNLICENSED)

**dependencies** (13)

- `@paralleldrive/cuid2` @ `^2.2.2`
- `cors` @ `^2.8.5`
- `crypto` @ `^1.0.1`
- `dotenv` @ `^16.4.7`
- `express` @ `^5.2.1`
- `magika` @ `^1.0.0`
- `mammoth` @ `^1.8.0`
- `multer` @ `^1.4.5-lts.1`
- `pdfjs-dist` @ `^4.9.155`
- `pg` @ `^8.16.3`
- `pg-boss` @ `^10.1.6`
- `sharp` @ `^0.33.5`
- `tesseract.js` @ `^5.1.1`

**devDependencies** (9)

- `@types/cors` @ `^2.8.17`
- `@types/express` @ `^5.0.1`
- `@types/multer` @ `^1.4.12`
- `@types/node` @ `^22.10.6`
- `@types/supertest` @ `^6.0.3`
- `supertest` @ `^7.2.2`
- `ts-node` @ `^10.9.2`
- `tsx` @ `^4.19.2`
- `typescript` @ `^5.8.3`

### apps/realtime/package.json  (declared license: UNLICENSED)

**dependencies** (3)

- `cookie` @ `1.0.2`
- `dotenv` @ `^17.2.0`
- `socket.io` @ `^4.7.5`

**devDependencies** (2)

- `tsx` @ `^4.16.2`
- `typescript` @ `^5.5.2`

### apps/web/package.json  (declared license: UNLICENSED)

**dependencies** (104)

- `@ai-sdk/anthropic` @ `^2.0.4`
- `@ai-sdk/google` @ `^2.0.6`
- `@ai-sdk/openai` @ `^2.0.15`
- `@ai-sdk/openai-compatible` @ `^1.0.18`
- `@ai-sdk/react` @ `^2.0.12`
- `@ai-sdk/xai` @ `^2.0.8`
- `@capacitor/browser` @ `^7.0.3`
- `@capacitor/haptics` @ `^7.0.3`
- `@capacitor/keyboard` @ `^7.0.4`
- `@capacitor/push-notifications` @ `^7.0.4`
- `@dnd-kit/core` @ `^6.3.1`
- `@dnd-kit/sortable` @ `^10.0.0`
- `@dnd-kit/utilities` @ `^3.2.2`
- `@gridland/utils` @ `^0.2.53`
- `@gridland/web` @ `^0.2.53`
- `@monaco-editor/react` @ `^4.7.0`
- `@openrouter/ai-sdk-provider` @ `^1.1.2`
- `@paralleldrive/cuid2` @ `^2.2.2`
- `@radix-ui/react-accordion` @ `^1.2.11`
- `@radix-ui/react-alert-dialog` @ `^1.1.14`
- `@radix-ui/react-avatar` @ `^1.1.10`
- `@radix-ui/react-checkbox` @ `^1.3.2`
- `@radix-ui/react-collapsible` @ `^1.1.12`
- `@radix-ui/react-context-menu` @ `^2.2.16`
- `@radix-ui/react-dialog` @ `^1.1.15`
- `@radix-ui/react-dropdown-menu` @ `^2.1.16`
- `@radix-ui/react-hover-card` @ `^1.1.15`
- `@radix-ui/react-label` @ `^2.1.7`
- `@radix-ui/react-navigation-menu` @ `^1.2.13`
- `@radix-ui/react-popover` @ `^1.1.14`
- `@radix-ui/react-progress` @ `^1.1.7`
- `@radix-ui/react-radio-group` @ `^1.3.8`
- `@radix-ui/react-scroll-area` @ `^1.2.10`
- `@radix-ui/react-select` @ `^2.2.6`
- `@radix-ui/react-separator` @ `^1.1.7`
- `@radix-ui/react-slider` @ `^1.3.5`
- `@radix-ui/react-slot` @ `^1.2.3`
- `@radix-ui/react-switch` @ `^1.2.5`
- `@radix-ui/react-tabs` @ `^1.1.12`
- `@radix-ui/react-toggle` @ `^1.1.10`
- `@radix-ui/react-tooltip` @ `^1.2.8`
- `@radix-ui/react-use-controllable-state` @ `^1.2.2`
- `@simplewebauthn/browser` @ `^13.2.2`
- `@stripe/react-stripe-js` @ `^5.4.1`
- `@stripe/stripe-js` @ `^8.5.3`
- `@tanstack/react-virtual` @ `^3.13.18`
- `@tiptap/core` @ `^3.7.2`
- `@tiptap/extension-code-block` @ `^3.6.1`
- `@tiptap/extension-mention` @ `^3.0.7`
- `@tiptap/extension-table` @ `^3.0.7`
- `@tiptap/extension-text-style` @ `^3.0.7`
- `@tiptap/extensions` @ `^3.0.7`
- `@tiptap/pm` @ `^3.7.2`
- `@tiptap/react` @ `^3.0.7`
- `@tiptap/starter-kit` @ `^3.0.7`
- `@types/archiver` @ `^7.0.0`
- `@xyflow/react` @ `^12.10.0`
- `ai` @ `^5.0.54`
- `archiver` @ `^7.0.1`
- `cheerio` @ `^1.1.2`
- `chrono-node` @ `^2.9.0`
- `class-variance-authority` @ `^0.7.1`
- `clsx` @ `^2.1.1`
- `cmdk` @ `^1.1.1`
- `cookie` @ `1.0.2`
- `cron-parser` @ `^5.5.0`
- `cronstrue` @ `^3.12.0`
- `date-fns` @ `^4.1.0`
- `docx-preview` @ `^0.3.6`
- `dompurify` @ `^3.2.6`
- `embla-carousel-react` @ `^8.6.0`
- `google-auth-library` @ `^10.2.1`
- `lucide-react` @ `^0.525.0`
- `mammoth` @ `^1.10.0`
- `marked` @ `^17.0.1`
- `monaco-editor` @ `^0.52.2`
- `motion` @ `^12.23.22`
- `next` @ `15.3.9`
- `next-themes` @ `^0.4.6`
- `next-ws` @ `^2.1.5`
- `ollama-ai-provider-v2` @ `^1.3.1`
- `react` @ `^19.1.2`
- `react-day-picker` @ `^9.11.3`
- `react-dom` @ `^19.1.2`
- `react-hook-form` @ `^7.62.0`
- `react-image-crop` @ `^11.0.10`
- `react-pdf` @ `^10.1.0`
- `recharts` @ `^3.1.2`
- `shiki` @ `^3.22.0`
- `socket.io-client` @ `^4.8.1`
- `sonner` @ `^2.0.6`
- `streamdown` @ `^1.6.9`
- `stripe` @ `^20.1.0`
- `swr` @ `^2.3.4`
- `tailwind-merge` @ `^3.3.1`
- `tippy.js` @ `^6.3.7`
- `tiptap-markdown` @ `^0.8.10`
- `tokenlens` @ `^1.3.1`
- `turndown` @ `^7.2.2`
- `use-debounce` @ `^10.0.5`
- `use-stick-to-bottom` @ `^1.1.1`
- `ws` @ `^8.18.3`
- `zod` @ `^4.0.16`
- `zustand` @ `^5.0.6`

**devDependencies** (21)

- `@capacitor/app` @ `^7.1.1`
- `@capacitor/browser` @ `^7.0.3`
- `@capacitor/core` @ `^7.0.0`
- `@capacitor/preferences` @ `^7.0.0`
- `@capgo/capacitor-social-login` @ `^7.0.5`
- `@eslint/eslintrc` @ `^3`
- `@next/eslint-plugin-next` @ `15.3.9`
- `@tailwindcss/postcss` @ `^4`
- `@types/dompurify` @ `^3.2.0`
- `@types/node` @ `^20`
- `@types/react` @ `^19`
- `@types/react-dom` @ `^19`
- `@types/turndown` @ `^5.0.6`
- `@types/ws` @ `^8.18.1`
- `copy-webpack-plugin` @ `^12.0.2`
- `eslint` @ `^9`
- `eslint-config-next` @ `15.3.9`
- `eslint-plugin-react-hooks` @ `^5.2.0`
- `tailwindcss` @ `^4`
- `tw-animate-css` @ `^1.3.5`
- `typescript` @ `^5`

### packages/db/package.json  (declared license: UNLICENSED)

**dependencies** (4)

- `@paralleldrive/cuid2` @ `^2.2.2`
- `dotenv` @ `^17.2.0`
- `drizzle-orm` @ `^0.32.2`
- `pg` @ `^8.16.3`

**devDependencies** (3)

- `@types/pg` @ `^8.15.4`
- `drizzle-kit` @ `^0.23.2`
- `tsx` @ `^4.20.3`

### packages/lib/package.json  (declared license: UNLICENSED)

**dependencies** (21)

- `@iarna/toml` @ `^2.2.5`
- `@paralleldrive/cuid2` @ `^2.2.2`
- `@react-email/components` @ `^0.5.5`
- `@simplewebauthn/server` @ `^13.2.2`
- `apple-signin-auth` @ `^2.0.0`
- `diff-match-patch` @ `^1.0.5`
- `drizzle-orm` @ `^0.32.2`
- `google-auth-library` @ `^10.3.0`
- `html-to-docx` @ `^1.8.0`
- `ioredis` @ `^5.8.0`
- `mammoth` @ `^1.10.0`
- `pako` @ `^2.1.0`
- `pdf-parse-debugging-disabled` @ `^1.1.1`
- `react` @ `^19.1.2`
- `react-dom` @ `^19.1.2`
- `react-email` @ `^5.1.1`
- `resend` @ `^6.1.2`
- `server-only` @ `^0.0.1`
- `xlsx` @ `^0.18.5`
- `yaml` @ `^2.8.2`
- `zod` @ `^4.0.16`

**devDependencies** (6)

- `@react-email/preview-server` @ `5.1.1`
- `@types/diff-match-patch` @ `^1.0.36`
- `@types/html-to-docx` @ `^1.8.0`
- `@types/pako` @ `^2.0.3`
- `@types/react` @ `^19.1.13`
- `@types/xlsx` @ `^0.0.36`

### prototypes/pagespace-cli-architecture/package.json  (declared license: UNLICENSED)

**dependencies** (2)

- `react` @ `^19.1.0`
- `react-dom` @ `^19.1.0`

**devDependencies** (5)

- `@types/react` @ `^19.1.2`
- `@types/react-dom` @ `^19.1.2`
- `@vitejs/plugin-react` @ `^4.4.1`
- `typescript` @ `~5.8.3`
- `vite` @ `^6.3.2`

### prototypes/pagespace-endgame/package.json  (declared license: UNLICENSED)

**dependencies** (2)

- `react` @ `^19.1.0`
- `react-dom` @ `^19.1.0`

**devDependencies** (5)

- `@types/react` @ `^19.1.2`
- `@types/react-dom` @ `^19.1.2`
- `@vitejs/plugin-react` @ `^4.4.1`
- `typescript` @ `~5.8.3`
- `vite` @ `^6.3.2`

---

## 8. Full Transitive SBOM (2,104 packages)

| Package | Version | License |
|---|---|---|
| @adobe/css-tools | 4.4.4 | MIT |
| @ai-sdk/anthropic | 2.0.19 | Apache-2.0 |
| @ai-sdk/gateway | 1.0.30 | Apache-2.0 |
| @ai-sdk/google | 2.0.17 | Apache-2.0 |
| @ai-sdk/openai | 2.0.36 | Apache-2.0 |
| @ai-sdk/openai-compatible | 1.0.19 | Apache-2.0 |
| @ai-sdk/provider | 2.0.0 | Apache-2.0 |
| @ai-sdk/provider-utils | 3.0.10 | Apache-2.0 |
| @ai-sdk/react | 2.0.54 | Apache-2.0 |
| @ai-sdk/xai | 2.0.23 | Apache-2.0 |
| @alloc/quick-lru | 5.2.0 | MIT |
| @ampproject/remapping | 2.3.0 | Apache-2.0 |
| @antfu/install-pkg | 1.1.0 | MIT |
| @antfu/ni | 25.0.0 | MIT |
| @asamuzakjp/css-color | 3.2.0 | MIT |
| @babel/code-frame | 7.27.1 | MIT |
| @babel/code-frame | 7.29.0 | MIT |
| @babel/compat-data | 7.28.4 | MIT |
| @babel/core | 7.28.4 | MIT |
| @babel/generator | 7.28.3 | MIT |
| @babel/generator | 7.28.5 | MIT |
| @babel/helper-annotate-as-pure | 7.27.3 | MIT |
| @babel/helper-compilation-targets | 7.27.2 | MIT |
| @babel/helper-create-class-features-plugin | 7.28.5 | MIT |
| @babel/helper-globals | 7.28.0 | MIT |
| @babel/helper-member-expression-to-functions | 7.28.5 | MIT |
| @babel/helper-module-imports | 7.27.1 | MIT |
| @babel/helper-module-transforms | 7.28.3 | MIT |
| @babel/helper-optimise-call-expression | 7.27.1 | MIT |
| @babel/helper-plugin-utils | 7.27.1 | MIT |
| @babel/helper-replace-supers | 7.27.1 | MIT |
| @babel/helper-skip-transparent-expression-wrappers | 7.27.1 | MIT |
| @babel/helper-string-parser | 7.27.1 | MIT |
| @babel/helper-validator-identifier | 7.28.5 | MIT |
| @babel/helper-validator-option | 7.27.1 | MIT |
| @babel/helpers | 7.28.4 | MIT |
| @babel/parser | 7.28.4 | MIT |
| @babel/parser | 7.28.5 | MIT |
| @babel/plugin-syntax-flow | 7.27.1 | MIT |
| @babel/plugin-syntax-jsx | 7.27.1 | MIT |
| @babel/plugin-syntax-typescript | 7.27.1 | MIT |
| @babel/plugin-transform-arrow-functions | 7.27.1 | MIT |
| @babel/plugin-transform-class-properties | 7.27.1 | MIT |
| @babel/plugin-transform-flow-strip-types | 7.27.1 | MIT |
| @babel/plugin-transform-modules-commonjs | 7.27.1 | MIT |
| @babel/plugin-transform-nullish-coalescing-operator | 7.27.1 | MIT |
| @babel/plugin-transform-optional-chaining | 7.28.5 | MIT |
| @babel/plugin-transform-private-methods | 7.27.1 | MIT |
| @babel/plugin-transform-react-jsx-self | 7.27.1 | MIT |
| @babel/plugin-transform-react-jsx-source | 7.27.1 | MIT |
| @babel/plugin-transform-typescript | 7.28.5 | MIT |
| @babel/preset-flow | 7.27.1 | MIT |
| @babel/preset-typescript | 7.28.5 | MIT |
| @babel/register | 7.28.3 | MIT |
| @babel/runtime | 7.28.4 | MIT |
| @babel/runtime | 7.28.6 | MIT |
| @babel/template | 7.27.2 | MIT |
| @babel/traverse | 7.28.4 | MIT |
| @babel/traverse | 7.28.5 | MIT |
| @babel/types | 7.28.4 | MIT |
| @babel/types | 7.28.5 | MIT |
| @base-ui/react | 1.2.0 | MIT |
| @base-ui/utils | 0.2.5 | MIT |
| @bcoe/v8-coverage | 0.2.3 | MIT |
| @braintree/sanitize-url | 7.1.1 | MIT |
| @bundled-es-modules/cookie | 2.0.1 | ISC |
| @bundled-es-modules/statuses | 1.0.1 | ISC |
| @capacitor/android | 7.4.5 | MIT |
| @capacitor/app | 7.1.1 | MIT |
| @capacitor/browser | 7.0.3 | MIT |
| @capacitor/cli | 7.4.5 | MIT |
| @capacitor/core | 7.4.5 | MIT |
| @capacitor/haptics | 7.0.3 | MIT |
| @capacitor/ios | 7.4.5 | MIT |
| @capacitor/keyboard | 7.0.4 | MIT |
| @capacitor/preferences | 7.0.3 | MIT |
| @capacitor/push-notifications | 7.0.4 | MIT |
| @capacitor/splash-screen | 7.0.4 | MIT |
| @capacitor/status-bar | 7.0.4 | MIT |
| @capgo/capacitor-social-login | 7.20.0 | MPL-2.0 |
| @chevrotain/cst-dts-gen | 11.0.3 | Apache-2.0 |
| @chevrotain/gast | 11.0.3 | Apache-2.0 |
| @chevrotain/regexp-to-ast | 11.0.3 | Apache-2.0 |
| @chevrotain/types | 11.0.3 | Apache-2.0 |
| @chevrotain/utils | 11.0.3 | Apache-2.0 |
| @cspotcode/source-map-support | 0.8.1 | MIT |
| @csstools/color-helpers | 5.1.0 | MIT-0 |
| @csstools/css-calc | 2.1.4 | MIT |
| @csstools/css-color-parser | 3.1.0 | MIT |
| @csstools/css-parser-algorithms | 3.0.5 | MIT |
| @csstools/css-tokenizer | 3.0.4 | MIT |
| @date-fns/tz | 1.4.1 | MIT |
| @develar/schema-utils | 2.6.5 | MIT |
| @dnd-kit/accessibility | 3.1.1 | MIT |
| @dnd-kit/core | 6.3.1 | MIT |
| @dnd-kit/sortable | 10.0.0 | MIT |
| @dnd-kit/utilities | 3.2.2 | MIT |
| @dotenvx/dotenvx | 1.52.0 | BSD-3-Clause |
| @drizzle-team/brocli | 0.8.2 | Apache-2.0 |
| @ecies/ciphers | 0.2.5 | MIT |
| @electron/asar | 3.2.18 | MIT |
| @electron/asar | 3.4.1 | MIT |
| @electron/fuses | 1.8.0 | MIT |
| @electron/get | 2.0.3 | MIT |
| @electron/node-gyp | 10.2.0-electron.1 | MIT |
| @electron/notarize | 2.5.0 | MIT |
| @electron/osx-sign | 1.3.1 | BSD-2-Clause |
| @electron/rebuild | 3.7.0 | MIT |
| @electron/universal | 2.0.1 | MIT |
| @electron/windows-sign | 1.2.2 | BSD-2-Clause |
| @esbuild-kit/core-utils | 3.3.2 | MIT |
| @esbuild-kit/esm-loader | 2.6.5 | MIT |
| @esbuild/linux-x64 | 0.18.20 | MIT |
| @esbuild/linux-x64 | 0.19.12 | MIT |
| @esbuild/linux-x64 | 0.21.5 | MIT |
| @esbuild/linux-x64 | 0.25.10 | MIT |
| @esbuild/linux-x64 | 0.27.2 | MIT |
| @eslint-community/eslint-utils | 4.9.0 | MIT |
| @eslint-community/regexpp | 4.12.1 | MIT |
| @eslint/config-array | 0.21.0 | Apache-2.0 |
| @eslint/config-helpers | 0.3.1 | Apache-2.0 |
| @eslint/core | 0.15.2 | Apache-2.0 |
| @eslint/eslintrc | 3.3.1 | MIT |
| @eslint/js | 9.36.0 | MIT |
| @eslint/object-schema | 2.1.6 | Apache-2.0 |
| @eslint/plugin-kit | 0.3.5 | Apache-2.0 |
| @faker-js/faker | 9.9.0 | MIT |
| @fastify/ajv-compiler | 4.0.5 | MIT |
| @fastify/error | 4.2.0 | MIT |
| @fastify/fast-json-stringify-compiler | 5.0.3 | MIT |
| @fastify/forwarded | 3.0.1 | MIT |
| @fastify/merge-json-schemas | 0.2.1 | MIT |
| @fastify/proxy-addr | 5.1.0 | MIT |
| @floating-ui/core | 1.7.3 | MIT |
| @floating-ui/dom | 1.7.4 | MIT |
| @floating-ui/react-dom | 2.1.6 | MIT |
| @floating-ui/utils | 0.2.10 | MIT |
| @fontsource/ibm-plex-mono | 5.2.7 | OFL-1.1 |
| @fontsource/space-grotesk | 5.2.10 | OFL-1.1 |
| @gar/promisify | 1.1.3 | MIT |
| @gridland/utils | 0.2.53 | UNKNOWN |
| @gridland/web | 0.2.53 | UNKNOWN |
| @hexagon/base64 | 1.1.28 | MIT |
| @hono/node-server | 1.19.9 | MIT |
| @hookform/resolvers | 5.2.2 | MIT |
| @humanfs/core | 0.19.1 | Apache-2.0 |
| @humanfs/node | 0.16.7 | Apache-2.0 |
| @humanwhocodes/module-importer | 1.0.1 | Apache-2.0 |
| @humanwhocodes/retry | 0.4.3 | Apache-2.0 |
| @iarna/toml | 2.2.5 | ISC |
| @iconify/types | 2.0.0 | MIT |
| @iconify/utils | 3.1.0 | MIT |
| @img/colour | 1.0.0 | MIT |
| @img/sharp-libvips-linux-x64 | 1.0.4 | LGPL-3.0-or-later |
| @img/sharp-libvips-linux-x64 | 1.2.3 | LGPL-3.0-or-later |
| @img/sharp-libvips-linuxmusl-x64 | 1.0.4 | LGPL-3.0-or-later |
| @img/sharp-libvips-linuxmusl-x64 | 1.2.3 | LGPL-3.0-or-later |
| @img/sharp-linux-x64 | 0.33.5 | Apache-2.0 |
| @img/sharp-linux-x64 | 0.34.4 | Apache-2.0 |
| @img/sharp-linuxmusl-x64 | 0.33.5 | Apache-2.0 |
| @img/sharp-linuxmusl-x64 | 0.34.4 | Apache-2.0 |
| @inquirer/ansi | 1.0.0 | MIT |
| @inquirer/confirm | 5.1.18 | MIT |
| @inquirer/core | 10.2.2 | MIT |
| @inquirer/figures | 1.0.13 | MIT |
| @inquirer/type | 3.0.8 | MIT |
| @ionic/cli-framework-output | 2.2.8 | MIT |
| @ionic/utils-array | 2.1.6 | MIT |
| @ionic/utils-fs | 3.1.7 | MIT |
| @ionic/utils-object | 2.1.6 | MIT |
| @ionic/utils-process | 2.1.12 | MIT |
| @ionic/utils-stream | 3.1.7 | MIT |
| @ionic/utils-subprocess | 3.0.1 | MIT |
| @ionic/utils-terminal | 2.3.5 | MIT |
| @ioredis/commands | 1.4.0 | MIT |
| @isaacs/balanced-match | 4.0.1 | MIT |
| @isaacs/brace-expansion | 5.0.0 | MIT |
| @isaacs/cliui | 8.0.2 | ISC |
| @isaacs/fs-minipass | 4.0.1 | ISC |
| @istanbuljs/schema | 0.1.3 | MIT |
| @jest/diff-sequences | 30.0.1 | MIT |
| @jest/expect-utils | 30.1.2 | MIT |
| @jest/get-type | 30.1.0 | MIT |
| @jest/pattern | 30.0.1 | MIT |
| @jest/schemas | 30.0.5 | MIT |
| @jest/types | 30.0.5 | MIT |
| @jridgewell/gen-mapping | 0.3.13 | MIT |
| @jridgewell/remapping | 2.3.5 | MIT |
| @jridgewell/resolve-uri | 3.1.2 | MIT |
| @jridgewell/source-map | 0.3.11 | MIT |
| @jridgewell/sourcemap-codec | 1.5.5 | MIT |
| @jridgewell/trace-mapping | 0.3.31 | MIT |
| @jridgewell/trace-mapping | 0.3.9 | MIT |
| @levischuck/tiny-cbor | 0.2.11 | MIT |
| @malept/cross-spawn-promise | 2.0.0 | Apache-2.0 |
| @malept/flatpak-bundler | 0.4.0 | MIT |
| @mapbox/node-pre-gyp | 1.0.9 | BSD-3-Clause |
| @mermaid-js/parser | 0.6.3 | MIT |
| @mixmark-io/domino | 2.2.0 | BSD-2-Clause |
| @modelcontextprotocol/sdk | 1.26.0 | MIT |
| @monaco-editor/loader | 1.5.0 | MIT |
| @monaco-editor/react | 4.7.0 | MIT |
| @mswjs/interceptors | 0.39.7 | MIT |
| @napi-rs/canvas | 0.1.80 | MIT |
| @napi-rs/canvas-linux-x64-gnu | 0.1.80 | MIT |
| @napi-rs/canvas-linux-x64-musl | 0.1.80 | MIT |
| @next/env | 15.3.9 | MIT |
| @next/env | 16.0.10 | MIT |
| @next/eslint-plugin-next | 15.3.9 | MIT |
| @next/swc-linux-x64-gnu | 15.3.5 | MIT |
| @next/swc-linux-x64-gnu | 16.0.10 | MIT |
| @next/swc-linux-x64-musl | 15.3.5 | MIT |
| @next/swc-linux-x64-musl | 16.0.10 | MIT |
| @noble/ciphers | 1.3.0 | MIT |
| @noble/curves | 1.9.7 | MIT |
| @noble/hashes | 1.8.0 | MIT |
| @nodelib/fs.scandir | 2.1.5 | MIT |
| @nodelib/fs.stat | 2.0.5 | MIT |
| @nodelib/fs.walk | 1.2.8 | MIT |
| @nolyfill/is-core-module | 1.0.39 | MIT |
| @npmcli/fs | 2.1.2 | ISC |
| @npmcli/move-file | 2.0.1 | MIT |
| @oozcitak/dom | 1.15.5 | MIT |
| @oozcitak/dom | 1.15.6 | MIT |
| @oozcitak/infra | 1.0.3 | MIT |
| @oozcitak/infra | 1.0.5 | MIT |
| @oozcitak/url | 1.0.0 | MIT |
| @oozcitak/util | 1.0.1 | MIT |
| @oozcitak/util | 1.0.2 | MIT |
| @oozcitak/util | 8.0.0 | MIT |
| @oozcitak/util | 8.3.3 | MIT |
| @oozcitak/util | 8.3.4 | MIT |
| @open-draft/deferred-promise | 2.2.0 | MIT |
| @open-draft/logger | 0.3.0 | MIT |
| @open-draft/until | 2.1.0 | MIT |
| @openrouter/ai-sdk-provider | 1.2.0 | Apache-2.0 |
| @opentelemetry/api | 1.9.0 | Apache-2.0 |
| @oxc-resolver/binding-linux-x64-gnu | 11.14.0 | MIT |
| @oxc-resolver/binding-linux-x64-musl | 11.14.0 | MIT |
| @paralleldrive/cuid2 | 2.2.2 | MIT |
| @peculiar/asn1-android | 2.6.0 | MIT |
| @peculiar/asn1-cms | 2.6.1 | MIT |
| @peculiar/asn1-csr | 2.6.1 | MIT |
| @peculiar/asn1-ecc | 2.6.1 | MIT |
| @peculiar/asn1-pfx | 2.6.1 | MIT |
| @peculiar/asn1-pkcs8 | 2.6.1 | MIT |
| @peculiar/asn1-pkcs9 | 2.6.1 | MIT |
| @peculiar/asn1-rsa | 2.6.1 | MIT |
| @peculiar/asn1-schema | 2.6.0 | MIT |
| @peculiar/asn1-x509 | 2.6.1 | MIT |
| @peculiar/asn1-x509-attr | 2.6.1 | MIT |
| @peculiar/x509 | 1.14.3 | MIT |
| @pinojs/redact | 0.4.0 | MIT |
| @pkgjs/parseargs | 0.11.0 | MIT |
| @playwright/test | 1.55.1 | Apache-2.0 |
| @polka/url | 1.0.0-next.29 | MIT |
| @popperjs/core | 2.11.8 | MIT |
| @radix-ui/number | 1.1.1 | MIT |
| @radix-ui/primitive | 1.1.3 | MIT |
| @radix-ui/react-accessible-icon | 1.1.7 | MIT |
| @radix-ui/react-accordion | 1.2.12 | MIT |
| @radix-ui/react-alert-dialog | 1.1.15 | MIT |
| @radix-ui/react-arrow | 1.1.7 | MIT |
| @radix-ui/react-aspect-ratio | 1.1.7 | MIT |
| @radix-ui/react-avatar | 1.1.10 | MIT |
| @radix-ui/react-checkbox | 1.3.3 | MIT |
| @radix-ui/react-collapsible | 1.1.12 | MIT |
| @radix-ui/react-collection | 1.1.7 | MIT |
| @radix-ui/react-compose-refs | 1.1.2 | MIT |
| @radix-ui/react-context | 1.1.2 | MIT |
| @radix-ui/react-context-menu | 2.2.16 | MIT |
| @radix-ui/react-dialog | 1.1.15 | MIT |
| @radix-ui/react-direction | 1.1.1 | MIT |
| @radix-ui/react-dismissable-layer | 1.1.11 | MIT |
| @radix-ui/react-dropdown-menu | 2.1.16 | MIT |
| @radix-ui/react-focus-guards | 1.1.3 | MIT |
| @radix-ui/react-focus-scope | 1.1.7 | MIT |
| @radix-ui/react-form | 0.1.8 | MIT |
| @radix-ui/react-hover-card | 1.1.15 | MIT |
| @radix-ui/react-id | 1.1.1 | MIT |
| @radix-ui/react-label | 2.1.7 | MIT |
| @radix-ui/react-menu | 2.1.16 | MIT |
| @radix-ui/react-menubar | 1.1.16 | MIT |
| @radix-ui/react-navigation-menu | 1.2.14 | MIT |
| @radix-ui/react-one-time-password-field | 0.1.8 | MIT |
| @radix-ui/react-password-toggle-field | 0.1.3 | MIT |
| @radix-ui/react-popover | 1.1.15 | MIT |
| @radix-ui/react-popper | 1.2.8 | MIT |
| @radix-ui/react-portal | 1.1.9 | MIT |
| @radix-ui/react-presence | 1.1.5 | MIT |
| @radix-ui/react-primitive | 2.1.3 | MIT |
| @radix-ui/react-progress | 1.1.7 | MIT |
| @radix-ui/react-radio-group | 1.3.8 | MIT |
| @radix-ui/react-roving-focus | 1.1.11 | MIT |
| @radix-ui/react-scroll-area | 1.2.10 | MIT |
| @radix-ui/react-select | 2.2.6 | MIT |
| @radix-ui/react-separator | 1.1.7 | MIT |
| @radix-ui/react-slider | 1.3.6 | MIT |
| @radix-ui/react-slot | 1.2.3 | MIT |
| @radix-ui/react-switch | 1.2.6 | MIT |
| @radix-ui/react-tabs | 1.1.13 | MIT |
| @radix-ui/react-toast | 1.2.15 | MIT |
| @radix-ui/react-toggle | 1.1.10 | MIT |
| @radix-ui/react-toggle-group | 1.1.11 | MIT |
| @radix-ui/react-toolbar | 1.1.11 | MIT |
| @radix-ui/react-tooltip | 1.2.8 | MIT |
| @radix-ui/react-use-callback-ref | 1.1.1 | MIT |
| @radix-ui/react-use-controllable-state | 1.2.2 | MIT |
| @radix-ui/react-use-effect-event | 0.0.2 | MIT |
| @radix-ui/react-use-escape-keydown | 1.1.1 | MIT |
| @radix-ui/react-use-is-hydrated | 0.1.0 | MIT |
| @radix-ui/react-use-layout-effect | 1.1.1 | MIT |
| @radix-ui/react-use-previous | 1.1.1 | MIT |
| @radix-ui/react-use-rect | 1.1.1 | MIT |
| @radix-ui/react-use-size | 1.1.1 | MIT |
| @radix-ui/react-visually-hidden | 1.2.3 | MIT |
| @radix-ui/rect | 1.1.1 | MIT |
| @react-email/body | 0.1.0 | MIT |
| @react-email/button | 0.2.0 | MIT |
| @react-email/code-block | 0.1.0 | MIT |
| @react-email/code-inline | 0.0.5 | MIT |
| @react-email/column | 0.0.13 | MIT |
| @react-email/components | 0.5.5 | MIT |
| @react-email/container | 0.0.15 | MIT |
| @react-email/font | 0.0.9 | MIT |
| @react-email/head | 0.0.12 | MIT |
| @react-email/heading | 0.0.15 | MIT |
| @react-email/hr | 0.0.11 | MIT |
| @react-email/html | 0.0.11 | MIT |
| @react-email/img | 0.0.11 | MIT |
| @react-email/link | 0.0.12 | MIT |
| @react-email/markdown | 0.0.15 | MIT |
| @react-email/preview | 0.0.13 | MIT |
| @react-email/preview-server | 5.1.1 | MIT |
| @react-email/render | 1.3.1 | MIT |
| @react-email/row | 0.0.12 | MIT |
| @react-email/section | 0.0.16 | MIT |
| @react-email/tailwind | 1.2.2 | MIT |
| @react-email/text | 0.1.5 | MIT |
| @reduxjs/toolkit | 2.9.0 | MIT |
| @remirror/core-constants | 3.0.0 | MIT |
| @rolldown/pluginutils | 1.0.0-beta.27 | MIT |
| @rollup/rollup-linux-x64-gnu | 4.52.3 | MIT |
| @rollup/rollup-linux-x64-musl | 4.52.3 | MIT |
| @rtsao/scc | 1.1.0 | MIT |
| @rushstack/eslint-patch | 1.12.0 | MIT |
| @sec-ant/readable-stream | 0.4.1 | MIT |
| @selderee/plugin-htmlparser2 | 0.11.0 | MIT |
| @shikijs/core | 3.22.0 | MIT |
| @shikijs/engine-javascript | 3.22.0 | MIT |
| @shikijs/engine-oniguruma | 3.22.0 | MIT |
| @shikijs/langs | 3.22.0 | MIT |
| @shikijs/themes | 3.22.0 | MIT |
| @shikijs/types | 3.22.0 | MIT |
| @shikijs/vscode-textmate | 10.0.2 | MIT |
| @simplewebauthn/browser | 13.2.2 | MIT |
| @simplewebauthn/server | 13.2.2 | MIT |
| @sinclair/typebox | 0.34.41 | MIT |
| @sindresorhus/is | 4.6.0 | MIT |
| @sindresorhus/merge-streams | 2.3.0 | MIT |
| @sindresorhus/merge-streams | 4.0.0 | MIT |
| @socket.io/component-emitter | 3.1.2 | MIT |
| @standard-schema/spec | 1.0.0 | MIT |
| @standard-schema/utils | 0.3.0 | MIT |
| @stripe/react-stripe-js | 5.4.1 | MIT |
| @stripe/stripe-js | 8.5.3 | MIT |
| @swc/counter | 0.1.3 | Apache-2.0 |
| @swc/helpers | 0.5.15 | Apache-2.0 |
| @szmarczak/http-timer | 4.0.6 | MIT |
| @tailwindcss/node | 4.1.13 | MIT |
| @tailwindcss/oxide | 4.1.13 | MIT |
| @tailwindcss/oxide-linux-x64-gnu | 4.1.13 | MIT |
| @tailwindcss/oxide-linux-x64-musl | 4.1.13 | MIT |
| @tailwindcss/postcss | 4.1.13 | MIT |
| @tailwindcss/typography | 0.5.19 | MIT |
| @tanstack/react-virtual | 3.13.18 | MIT |
| @tanstack/virtual-core | 3.13.18 | MIT |
| @tensorflow/tfjs | 4.22.0 | Apache-2.0 |
| @tensorflow/tfjs-backend-cpu | 4.22.0 | Apache-2.0 |
| @tensorflow/tfjs-backend-webgl | 4.22.0 | Apache-2.0 |
| @tensorflow/tfjs-converter | 4.22.0 | Apache-2.0 |
| @tensorflow/tfjs-core | 4.22.0 | Apache-2.0 |
| @tensorflow/tfjs-data | 4.22.0 | Apache-2.0 |
| @tensorflow/tfjs-layers | 4.22.0 | Apache-2.0 AND MIT |
| @tensorflow/tfjs-node | 4.22.0 | Apache-2.0 |
| @testing-library/dom | 10.4.1 | MIT |
| @testing-library/jest-dom | 6.8.0 | MIT |
| @testing-library/react | 16.3.0 | MIT |
| @testing-library/user-event | 14.6.1 | MIT |
| @tiptap/core | 3.7.2 | MIT |
| @tiptap/extension-blockquote | 3.6.1 | MIT |
| @tiptap/extension-bold | 3.6.1 | MIT |
| @tiptap/extension-bubble-menu | 3.6.1 | MIT |
| @tiptap/extension-bullet-list | 3.6.1 | MIT |
| @tiptap/extension-code | 3.6.1 | MIT |
| @tiptap/extension-code-block | 3.19.0 | MIT |
| @tiptap/extension-code-block | 3.6.1 | MIT |
| @tiptap/extension-document | 3.6.1 | MIT |
| @tiptap/extension-dropcursor | 3.6.1 | MIT |
| @tiptap/extension-floating-menu | 3.6.1 | MIT |
| @tiptap/extension-gapcursor | 3.6.1 | MIT |
| @tiptap/extension-hard-break | 3.6.1 | MIT |
| @tiptap/extension-heading | 3.6.1 | MIT |
| @tiptap/extension-horizontal-rule | 3.6.1 | MIT |
| @tiptap/extension-italic | 3.6.1 | MIT |
| @tiptap/extension-link | 3.6.1 | MIT |
| @tiptap/extension-list | 3.6.1 | MIT |
| @tiptap/extension-list-item | 3.6.1 | MIT |
| @tiptap/extension-list-keymap | 3.6.1 | MIT |
| @tiptap/extension-mention | 3.6.1 | MIT |
| @tiptap/extension-ordered-list | 3.6.1 | MIT |
| @tiptap/extension-paragraph | 3.6.1 | MIT |
| @tiptap/extension-strike | 3.6.1 | MIT |
| @tiptap/extension-table | 3.6.1 | MIT |
| @tiptap/extension-text | 3.6.1 | MIT |
| @tiptap/extension-text-style | 3.6.1 | MIT |
| @tiptap/extension-underline | 3.6.1 | MIT |
| @tiptap/extensions | 3.6.1 | MIT |
| @tiptap/pm | 3.7.2 | MIT |
| @tiptap/react | 3.6.1 | MIT |
| @tiptap/starter-kit | 3.6.1 | MIT |
| @tiptap/suggestion | 3.6.1 | MIT |
| @tokenlens/core | 1.3.0 | MIT |
| @tokenlens/fetch | 1.3.0 | MIT |
| @tokenlens/helpers | 1.3.1 | MIT |
| @tokenlens/models | 1.3.0 | MIT |
| @tootallnate/once | 2.0.0 | MIT |
| @ts-morph/common | 0.27.0 | MIT |
| @tsconfig/node10 | 1.0.11 | MIT |
| @tsconfig/node12 | 1.0.11 | MIT |
| @tsconfig/node14 | 1.0.3 | MIT |
| @tsconfig/node16 | 1.0.4 | MIT |
| @types/archiver | 7.0.0 | MIT |
| @types/aria-query | 5.0.4 | MIT |
| @types/babel__core | 7.20.5 | MIT |
| @types/babel__generator | 7.27.0 | MIT |
| @types/babel__template | 7.4.4 | MIT |
| @types/babel__traverse | 7.28.0 | MIT |
| @types/body-parser | 1.19.6 | MIT |
| @types/cacheable-request | 6.0.3 | MIT |
| @types/connect | 3.4.38 | MIT |
| @types/cookie | 0.6.0 | MIT |
| @types/cookiejar | 2.1.5 | MIT |
| @types/cors | 2.8.19 | MIT |
| @types/d3 | 7.4.3 | MIT |
| @types/d3-array | 3.2.2 | MIT |
| @types/d3-axis | 3.0.6 | MIT |
| @types/d3-brush | 3.0.6 | MIT |
| @types/d3-chord | 3.0.6 | MIT |
| @types/d3-color | 3.1.3 | MIT |
| @types/d3-contour | 3.0.6 | MIT |
| @types/d3-delaunay | 6.0.4 | MIT |
| @types/d3-dispatch | 3.0.7 | MIT |
| @types/d3-drag | 3.0.7 | MIT |
| @types/d3-dsv | 3.0.7 | MIT |
| @types/d3-ease | 3.0.2 | MIT |
| @types/d3-fetch | 3.0.7 | MIT |
| @types/d3-force | 3.0.10 | MIT |
| @types/d3-format | 3.0.4 | MIT |
| @types/d3-geo | 3.1.0 | MIT |
| @types/d3-hierarchy | 3.1.7 | MIT |
| @types/d3-interpolate | 3.0.4 | MIT |
| @types/d3-path | 3.1.1 | MIT |
| @types/d3-polygon | 3.0.2 | MIT |
| @types/d3-quadtree | 3.0.6 | MIT |
| @types/d3-random | 3.0.3 | MIT |
| @types/d3-scale | 4.0.9 | MIT |
| @types/d3-scale-chromatic | 3.1.0 | MIT |
| @types/d3-selection | 3.0.11 | MIT |
| @types/d3-shape | 3.1.7 | MIT |
| @types/d3-time | 3.0.4 | MIT |
| @types/d3-time-format | 4.0.3 | MIT |
| @types/d3-timer | 3.0.2 | MIT |
| @types/d3-transition | 3.0.9 | MIT |
| @types/d3-zoom | 3.0.8 | MIT |
| @types/debug | 4.1.12 | MIT |
| @types/diff-match-patch | 1.0.36 | MIT |
| @types/dompurify | 3.2.0 | MIT |
| @types/eslint | 9.6.1 | MIT |
| @types/eslint-scope | 3.7.7 | MIT |
| @types/estree | 1.0.8 | MIT |
| @types/estree-jsx | 1.0.5 | MIT |
| @types/express | 5.0.3 | MIT |
| @types/express-serve-static-core | 5.0.7 | MIT |
| @types/fs-extra | 8.1.5 | MIT |
| @types/fs-extra | 9.0.13 | MIT |
| @types/geojson | 7946.0.16 | MIT |
| @types/hast | 3.0.4 | MIT |
| @types/html-to-docx | 1.8.0 | MIT |
| @types/http-cache-semantics | 4.0.4 | MIT |
| @types/http-errors | 2.0.5 | MIT |
| @types/istanbul-lib-coverage | 2.0.6 | MIT |
| @types/istanbul-lib-report | 3.0.3 | MIT |
| @types/istanbul-reports | 3.0.4 | MIT |
| @types/jest | 30.0.0 | MIT |
| @types/json-schema | 7.0.15 | MIT |
| @types/json5 | 0.0.29 | MIT |
| @types/katex | 0.16.7 | MIT |
| @types/keyv | 3.1.4 | MIT |
| @types/linkify-it | 3.0.5 | MIT |
| @types/linkify-it | 5.0.0 | MIT |
| @types/long | 4.0.2 | MIT |
| @types/markdown-it | 13.0.9 | MIT |
| @types/markdown-it | 14.1.2 | MIT |
| @types/mdast | 4.0.4 | MIT |
| @types/mdurl | 1.0.5 | MIT |
| @types/mdurl | 2.0.0 | MIT |
| @types/methods | 1.1.4 | MIT |
| @types/mime | 1.3.5 | MIT |
| @types/ms | 2.1.0 | MIT |
| @types/multer | 1.4.13 | MIT |
| @types/node | 20.19.17 | MIT |
| @types/node | 22.18.6 | MIT |
| @types/node | 24.5.2 | MIT |
| @types/node-fetch | 2.6.13 | MIT |
| @types/offscreencanvas | 2019.3.0 | MIT |
| @types/offscreencanvas | 2019.7.3 | MIT |
| @types/pako | 2.0.4 | MIT |
| @types/pg | 8.15.5 | MIT |
| @types/qs | 6.14.0 | MIT |
| @types/range-parser | 1.2.7 | MIT |
| @types/react | 19.1.13 | MIT |
| @types/react-dom | 19.1.9 | MIT |
| @types/readdir-glob | 1.1.5 | MIT |
| @types/responselike | 1.0.3 | MIT |
| @types/seedrandom | 2.4.34 | MIT |
| @types/send | 0.17.5 | MIT |
| @types/serve-static | 1.15.8 | MIT |
| @types/slice-ansi | 4.0.0 | MIT |
| @types/stack-utils | 2.0.3 | MIT |
| @types/statuses | 2.0.6 | MIT |
| @types/superagent | 8.1.9 | MIT |
| @types/supertest | 6.0.3 | MIT |
| @types/trusted-types | 2.0.7 | MIT |
| @types/turndown | 5.0.6 | MIT |
| @types/unist | 2.0.11 | MIT |
| @types/unist | 3.0.3 | MIT |
| @types/use-sync-external-store | 0.0.6 | MIT |
| @types/validate-npm-package-name | 4.0.2 | MIT |
| @types/ws | 8.18.1 | MIT |
| @types/xlsx | 0.0.36 | MIT |
| @types/yargs | 17.0.33 | MIT |
| @types/yargs-parser | 21.0.3 | MIT |
| @types/yauzl | 2.10.3 | MIT |
| @typescript-eslint/eslint-plugin | 8.44.1 | MIT |
| @typescript-eslint/parser | 8.44.1 | MIT |
| @typescript-eslint/project-service | 8.44.1 | MIT |
| @typescript-eslint/project-service | 8.46.0 | MIT |
| @typescript-eslint/scope-manager | 8.44.1 | MIT |
| @typescript-eslint/tsconfig-utils | 8.44.1 | MIT |
| @typescript-eslint/tsconfig-utils | 8.46.0 | MIT |
| @typescript-eslint/type-utils | 8.44.1 | MIT |
| @typescript-eslint/types | 8.44.1 | MIT |
| @typescript-eslint/types | 8.46.0 | MIT |
| @typescript-eslint/typescript-estree | 8.44.1 | MIT |
| @typescript-eslint/typescript-estree | 8.46.0 | MIT |
| @typescript-eslint/utils | 8.44.1 | MIT |
| @typescript-eslint/visitor-keys | 8.44.1 | MIT |
| @typescript-eslint/visitor-keys | 8.46.0 | MIT |
| @ungap/structured-clone | 1.3.0 | ISC |
| @unrs/resolver-binding-linux-x64-gnu | 1.11.1 | MIT |
| @unrs/resolver-binding-linux-x64-musl | 1.11.1 | MIT |
| @vitejs/plugin-react | 4.7.0 | MIT |
| @vitest/coverage-v8 | 2.1.9 | MIT |
| @vitest/expect | 2.1.9 | MIT |
| @vitest/mocker | 2.1.9 | MIT |
| @vitest/pretty-format | 2.1.9 | MIT |
| @vitest/runner | 2.1.9 | MIT |
| @vitest/snapshot | 2.1.9 | MIT |
| @vitest/spy | 2.1.9 | MIT |
| @vitest/ui | 2.1.9 | MIT |
| @vitest/utils | 2.1.9 | MIT |
| @webassemblyjs/ast | 1.14.1 | MIT |
| @webassemblyjs/floating-point-hex-parser | 1.13.2 | MIT |
| @webassemblyjs/helper-api-error | 1.13.2 | MIT |
| @webassemblyjs/helper-buffer | 1.14.1 | MIT |
| @webassemblyjs/helper-numbers | 1.13.2 | MIT |
| @webassemblyjs/helper-wasm-bytecode | 1.13.2 | MIT |
| @webassemblyjs/helper-wasm-section | 1.14.1 | MIT |
| @webassemblyjs/ieee754 | 1.13.2 | MIT |
| @webassemblyjs/leb128 | 1.13.2 | Apache-2.0 |
| @webassemblyjs/utf8 | 1.13.2 | MIT |
| @webassemblyjs/wasm-edit | 1.14.1 | MIT |
| @webassemblyjs/wasm-gen | 1.14.1 | MIT |
| @webassemblyjs/wasm-opt | 1.14.1 | MIT |
| @webassemblyjs/wasm-parser | 1.14.1 | MIT |
| @webassemblyjs/wast-printer | 1.14.1 | MIT |
| @webgpu/types | 0.1.38 | BSD-3-Clause |
| @xmldom/xmldom | 0.8.11 | MIT |
| @xtuc/ieee754 | 1.2.0 | BSD-3-Clause |
| @xtuc/long | 4.2.2 | Apache-2.0 |
| @xyflow/react | 12.10.0 | MIT |
| @xyflow/system | 0.0.74 | MIT |
| 7zip-bin | 5.2.0 | MIT |
| abbrev | 1.1.1 | ISC |
| abort-controller | 3.0.0 | MIT |
| abstract-logging | 2.0.1 | MIT |
| accepts | 1.3.8 | MIT |
| accepts | 2.0.0 | MIT |
| acorn | 8.15.0 | MIT |
| acorn-import-phases | 1.0.4 | MIT |
| acorn-jsx | 5.3.2 | MIT |
| acorn-walk | 8.3.4 | MIT |
| adler-32 | 1.3.1 | Apache-2.0 |
| adm-zip | 0.5.17 | MIT |
| agent-base | 4.3.0 | MIT |
| agent-base | 6.0.2 | MIT |
| agent-base | 7.1.4 | MIT |
| agentkeepalive | 4.6.0 | MIT |
| aggregate-error | 3.1.0 | MIT |
| ai | 5.0.54 | Apache-2.0 |
| ajv | 6.12.6 | MIT |
| ajv | 8.17.1 | MIT |
| ajv-formats | 2.1.1 | MIT |
| ajv-formats | 3.0.1 | MIT |
| ajv-keywords | 3.5.2 | MIT |
| ajv-keywords | 5.1.0 | MIT |
| ansi-regex | 5.0.1 | MIT |
| ansi-regex | 6.2.2 | MIT |
| ansi-styles | 4.3.0 | MIT |
| ansi-styles | 5.2.0 | MIT |
| ansi-styles | 6.2.3 | MIT |
| ansis | 4.2.0 | ISC |
| app-builder-bin | 5.0.0-alpha.12 | MIT |
| app-builder-lib | 26.0.12 | MIT |
| append-field | 1.0.0 | MIT |
| apple-signin-auth | 2.0.0 | MIT |
| aproba | 2.1.0 | ISC |
| archiver | 7.0.1 | MIT |
| archiver-utils | 5.0.2 | MIT |
| are-we-there-yet | 2.0.0 | ISC |
| arg | 4.1.3 | MIT |
| argparse | 1.0.10 | MIT |
| argparse | 2.0.1 | Python-2.0 |
| aria-hidden | 1.2.6 | MIT |
| aria-query | 5.3.0 | Apache-2.0 |
| aria-query | 5.3.2 | Apache-2.0 |
| array-buffer-byte-length | 1.0.2 | MIT |
| array-includes | 3.1.9 | MIT |
| array.prototype.findlast | 1.2.5 | MIT |
| array.prototype.findlastindex | 1.2.6 | MIT |
| array.prototype.flat | 1.3.3 | MIT |
| array.prototype.flatmap | 1.3.3 | MIT |
| array.prototype.tosorted | 1.1.4 | MIT |
| arraybuffer.prototype.slice | 1.0.4 | MIT |
| asap | 2.0.6 | MIT |
| asn1 | 0.2.6 | MIT |
| asn1js | 3.0.7 | BSD-3-Clause |
| assertion-error | 2.0.1 | MIT |
| ast-types | 0.16.1 | MIT |
| ast-types-flow | 0.0.8 | MIT |
| astral-regex | 2.0.0 | MIT |
| async | 3.2.6 | MIT |
| async-exit-hook | 2.0.1 | MIT |
| async-function | 1.0.0 | MIT |
| asynckit | 0.4.0 | MIT |
| at-least-node | 1.0.0 | ISC |
| atomic-sleep | 1.0.0 | MIT |
| atomically | 2.0.3 | UNKNOWN |
| available-typed-arrays | 1.0.7 | MIT |
| avvio | 9.2.0 | MIT |
| axe-core | 4.10.3 | MPL-2.0 |
| axobject-query | 4.1.0 | Apache-2.0 |
| b4a | 1.7.3 | Apache-2.0 |
| bail | 2.0.2 | MIT |
| balanced-match | 1.0.2 | MIT |
| bare-events | 2.8.2 | Apache-2.0 |
| base64-js | 1.5.1 | MIT |
| base64id | 2.0.0 | MIT |
| baseline-browser-mapping | 2.8.7 | Apache-2.0 |
| baseline-browser-mapping | 2.9.19 | Apache-2.0 |
| big-integer | 1.6.52 | Unlicense |
| bignumber.js | 9.3.1 | MIT |
| bl | 4.1.0 | MIT |
| bluebird | 3.4.7 | MIT |
| bmp-js | 0.1.0 | MIT |
| body-parser | 2.2.1 | MIT |
| boolbase | 1.0.0 | ISC |
| boolean | 3.2.0 | MIT |
| bplist-parser | 0.3.2 | MIT |
| brace-expansion | 1.1.12 | MIT |
| brace-expansion | 2.0.2 | MIT |
| braces | 3.0.3 | MIT |
| browser-split | 0.0.1 | MIT |
| browserslist | 4.26.2 | MIT |
| browserslist | 4.28.1 | MIT |
| buffer | 5.7.1 | MIT |
| buffer | 6.0.3 | MIT |
| buffer-crc32 | 0.2.13 | MIT |
| buffer-crc32 | 1.0.0 | MIT |
| buffer-equal-constant-time | 1.0.1 | BSD-3-Clause |
| buffer-from | 1.1.2 | MIT |
| builder-util | 26.0.11 | MIT |
| builder-util-runtime | 9.3.1 | MIT |
| bundle-name | 4.1.0 | MIT |
| busboy | 1.6.0 | MIT |
| bytes | 3.1.2 | MIT |
| cac | 6.7.14 | MIT |
| cacache | 16.1.3 | ISC |
| cacheable-lookup | 5.0.4 | MIT |
| cacheable-request | 7.0.4 | MIT |
| call-bind | 1.0.8 | MIT |
| call-bind-apply-helpers | 1.0.2 | MIT |
| call-bound | 1.0.4 | MIT |
| callsites | 3.1.0 | MIT |
| camelize | 1.0.1 | MIT |
| caniuse-lite | 1.0.30001745 | CC-BY-4.0 |
| caniuse-lite | 1.0.30001770 | CC-BY-4.0 |
| ccount | 2.0.1 | MIT |
| cfb | 1.2.2 | Apache-2.0 |
| chai | 5.3.3 | MIT |
| chalk | 4.1.2 | MIT |
| chalk | 5.6.2 | MIT |
| character-entities | 2.0.2 | MIT |
| character-entities-html4 | 2.1.0 | MIT |
| character-entities-legacy | 3.0.0 | MIT |
| character-reference-invalid | 2.0.1 | MIT |
| check-error | 2.1.1 | MIT |
| cheerio | 1.1.2 | MIT |
| cheerio-select | 2.1.0 | BSD-2-Clause |
| chevrotain | 11.0.3 | Apache-2.0 |
| chevrotain-allstar | 0.3.1 | MIT |
| chokidar | 4.0.3 | MIT |
| chownr | 2.0.0 | ISC |
| chownr | 3.0.0 | BlueOak-1.0.0 |
| chrome-trace-event | 1.0.4 | MIT |
| chromium-pickle-js | 0.2.0 | MIT |
| chrono-node | 2.9.0 | MIT |
| ci-info | 3.9.0 | MIT |
| ci-info | 4.3.0 | MIT |
| citty | 0.1.6 | MIT |
| class-variance-authority | 0.7.1 | Apache-2.0 |
| classcat | 5.0.5 | MIT |
| clean-stack | 2.2.0 | MIT |
| cli-cursor | 3.1.0 | MIT |
| cli-cursor | 5.0.0 | MIT |
| cli-spinners | 2.9.2 | MIT |
| cli-width | 4.1.0 | ISC |
| client-only | 0.0.1 | MIT |
| cliui | 7.0.4 | ISC |
| cliui | 8.0.1 | ISC |
| clone | 1.0.4 | MIT |
| clone-deep | 4.0.1 | MIT |
| clone-response | 1.0.3 | MIT |
| clsx | 2.1.1 | MIT |
| cluster-key-slot | 1.1.2 | Apache-2.0 |
| cmdk | 1.1.1 | MIT |
| code-block-writer | 13.0.3 | MIT |
| codepage | 1.15.0 | Apache-2.0 |
| color | 4.2.3 | MIT |
| color-convert | 2.0.1 | MIT |
| color-name | 1.1.4 | MIT |
| color-string | 1.9.1 | MIT |
| color-support | 1.1.3 | ISC |
| combined-stream | 1.0.8 | MIT |
| comma-separated-tokens | 2.0.3 | MIT |
| commander | 11.1.0 | MIT |
| commander | 12.1.0 | MIT |
| commander | 13.1.0 | MIT |
| commander | 14.0.3 | MIT |
| commander | 2.20.3 | MIT |
| commander | 5.1.0 | MIT |
| commander | 7.2.0 | MIT |
| commander | 8.3.0 | MIT |
| commander | 9.5.0 | MIT |
| commondir | 1.0.1 | MIT |
| compare-version | 0.1.2 | MIT |
| component-emitter | 1.3.1 | MIT |
| compress-commons | 6.0.2 | MIT |
| concat-map | 0.0.1 | MIT |
| concat-stream | 1.6.2 | MIT |
| conf | 14.0.0 | MIT |
| conf | 15.0.2 | MIT |
| confbox | 0.1.8 | MIT |
| confbox | 0.2.2 | MIT |
| config-file-ts | 0.2.8-rc1 | MIT |
| consola | 3.4.2 | MIT |
| console-control-strings | 1.1.0 | ISC |
| content-disposition | 1.0.1 | MIT |
| content-type | 1.0.5 | MIT |
| convert-source-map | 2.0.0 | MIT |
| cookie | 0.7.2 | MIT |
| cookie | 1.0.2 | MIT |
| cookie-signature | 1.2.2 | MIT |
| cookiejar | 2.1.4 | MIT |
| copy-webpack-plugin | 12.0.2 | MIT |
| core-js | 3.29.1 | MIT |
| core-util-is | 1.0.3 | MIT |
| cors | 2.8.5 | MIT |
| cose-base | 1.0.3 | MIT |
| cose-base | 2.2.0 | MIT |
| cosmiconfig | 9.0.0 | MIT |
| crc-32 | 1.2.2 | Apache-2.0 |
| crc32-stream | 6.0.0 | MIT |
| create-require | 1.1.1 | MIT |
| crelt | 1.0.6 | MIT |
| cron-parser | 4.9.0 | MIT |
| cron-parser | 5.5.0 | MIT |
| cronstrue | 3.12.0 | MIT |
| cross-dirname | 0.1.0 | MIT |
| cross-spawn | 7.0.6 | MIT |
| crypto | 1.0.1 | ISC |
| css-select | 5.2.2 | BSD-2-Clause |
| css-what | 6.2.2 | BSD-2-Clause |
| css.escape | 1.5.1 | MIT |
| cssesc | 3.0.0 | MIT |
| cssstyle | 4.6.0 | MIT |
| csstype | 3.1.3 | MIT |
| cytoscape | 3.33.1 | MIT |
| cytoscape-cose-bilkent | 4.1.0 | MIT |
| cytoscape-fcose | 2.2.0 | MIT |
| d3 | 7.9.0 | ISC |
| d3-array | 2.12.1 | BSD-3-Clause |
| d3-array | 3.2.4 | ISC |
| d3-axis | 3.0.0 | ISC |
| d3-brush | 3.0.0 | ISC |
| d3-chord | 3.0.1 | ISC |
| d3-color | 3.1.0 | ISC |
| d3-contour | 4.0.2 | ISC |
| d3-delaunay | 6.0.4 | ISC |
| d3-dispatch | 3.0.1 | ISC |
| d3-drag | 3.0.0 | ISC |
| d3-dsv | 3.0.1 | ISC |
| d3-ease | 3.0.1 | BSD-3-Clause |
| d3-fetch | 3.0.1 | ISC |
| d3-force | 3.0.0 | ISC |
| d3-format | 3.1.0 | ISC |
| d3-geo | 3.1.1 | ISC |
| d3-hierarchy | 3.1.2 | ISC |
| d3-interpolate | 3.0.1 | ISC |
| d3-path | 1.0.9 | BSD-3-Clause |
| d3-path | 3.1.0 | ISC |
| d3-polygon | 3.0.1 | ISC |
| d3-quadtree | 3.0.1 | ISC |
| d3-random | 3.0.1 | ISC |
| d3-sankey | 0.12.3 | BSD-3-Clause |
| d3-scale | 4.0.2 | ISC |
| d3-scale-chromatic | 3.1.0 | ISC |
| d3-selection | 3.0.0 | ISC |
| d3-shape | 1.3.7 | BSD-3-Clause |
| d3-shape | 3.2.0 | ISC |
| d3-time | 3.1.0 | ISC |
| d3-time-format | 4.1.0 | ISC |
| d3-timer | 3.0.1 | ISC |
| d3-transition | 3.0.1 | ISC |
| d3-zoom | 3.0.0 | ISC |
| dagre-d3-es | 7.0.13 | MIT |
| damerau-levenshtein | 1.0.8 | BSD-2-Clause |
| data-uri-to-buffer | 4.0.1 | MIT |
| data-urls | 5.0.0 | MIT |
| data-view-buffer | 1.0.2 | MIT |
| data-view-byte-length | 1.0.2 | MIT |
| data-view-byte-offset | 1.0.1 | MIT |
| date-fns | 4.1.0 | MIT |
| date-fns-jalali | 4.1.0-0 | MIT |
| dayjs | 1.11.19 | MIT |
| debounce | 2.2.0 | MIT |
| debounce-fn | 6.0.0 | MIT |
| debug | 3.2.7 | MIT |
| debug | 4.3.7 | MIT |
| debug | 4.4.3 | MIT |
| decimal.js | 10.6.0 | MIT |
| decimal.js-light | 2.5.1 | MIT |
| decode-named-character-reference | 1.2.0 | MIT |
| decompress-response | 6.0.0 | MIT |
| dedent | 1.7.1 | MIT |
| deep-eql | 5.0.2 | MIT |
| deep-is | 0.1.4 | MIT |
| deepmerge | 4.3.1 | MIT |
| default-browser | 5.5.0 | MIT |
| default-browser-id | 5.0.1 | MIT |
| defaults | 1.0.4 | MIT |
| defer-to-connect | 2.0.1 | MIT |
| define-data-property | 1.1.4 | MIT |
| define-lazy-prop | 2.0.0 | MIT |
| define-lazy-prop | 3.0.0 | MIT |
| define-properties | 1.2.1 | MIT |
| delaunator | 5.0.1 | ISC |
| delayed-stream | 1.0.0 | MIT |
| delegates | 1.0.0 | MIT |
| denque | 2.1.0 | Apache-2.0 |
| depd | 2.0.0 | MIT |
| dequal | 2.0.3 | MIT |
| detect-libc | 2.1.1 | Apache-2.0 |
| detect-node | 2.1.0 | MIT |
| detect-node-es | 1.1.0 | MIT |
| devlop | 1.1.0 | MIT |
| dezalgo | 1.0.4 | ISC |
| diff | 4.0.2 | BSD-3-Clause |
| diff | 8.0.3 | BSD-3-Clause |
| diff-match-patch | 1.0.5 | Apache-2.0 |
| dingbat-to-unicode | 1.0.1 | BSD-2-Clause |
| dir-compare | 4.2.0 | MIT |
| dmg-builder | 26.0.12 | MIT |
| doctrine | 2.1.0 | Apache-2.0 |
| docx-preview | 0.3.6 | Apache-2.0 |
| dom-accessibility-api | 0.5.16 | MIT |
| dom-accessibility-api | 0.6.3 | MIT |
| dom-helpers | 5.2.1 | MIT |
| dom-serializer | 0.2.2 | MIT |
| dom-serializer | 2.0.0 | MIT |
| dom-walk | 0.1.2 | MIT |
| domelementtype | 1.3.1 | BSD-2-Clause |
| domelementtype | 2.3.0 | BSD-2-Clause |
| domhandler | 2.4.2 | BSD-2-Clause |
| domhandler | 5.0.3 | BSD-2-Clause |
| dompurify | 3.2.7 | (MPL-2.0 OR Apache-2.0) |
| domutils | 1.7.0 | BSD-2-Clause |
| domutils | 3.2.2 | BSD-2-Clause |
| dot-prop | 10.1.0 | MIT |
| dot-prop | 9.0.0 | MIT |
| dotenv | 16.6.1 | BSD-2-Clause |
| dotenv | 17.2.2 | BSD-2-Clause |
| dotenv-expand | 11.0.7 | BSD-2-Clause |
| drizzle-kit | 0.23.2 | MIT |
| drizzle-orm | 0.32.2 | Apache-2.0 |
| duck | 0.1.12 | BSD |
| dunder-proto | 1.0.1 | MIT |
| eastasianwidth | 0.2.0 | MIT |
| ecdsa-sig-formatter | 1.0.11 | Apache-2.0 |
| eciesjs | 0.4.17 | MIT |
| ee-first | 1.1.1 | MIT |
| ejs | 3.1.10 | Apache-2.0 |
| electron | 33.4.11 | MIT |
| electron-builder | 26.0.12 | MIT |
| electron-builder-squirrel-windows | 26.0.12 | MIT |
| electron-publish | 26.0.11 | MIT |
| electron-store | 10.1.0 | MIT |
| electron-to-chromium | 1.5.224 | ISC |
| electron-to-chromium | 1.5.286 | ISC |
| electron-updater | 6.6.2 | MIT |
| electron-vite | 4.0.1 | MIT |
| electron-winstaller | 5.4.0 | MIT |
| elementtree | 0.1.7 | Apache-2.0 |
| embla-carousel | 8.6.0 | MIT |
| embla-carousel-react | 8.6.0 | MIT |
| embla-carousel-reactive-utils | 8.6.0 | MIT |
| emoji-regex | 10.5.0 | MIT |
| emoji-regex | 8.0.0 | MIT |
| emoji-regex | 9.2.2 | MIT |
| encodeurl | 2.0.0 | MIT |
| encoding | 0.1.13 | MIT |
| encoding-sniffer | 0.2.1 | MIT |
| end-of-stream | 1.4.5 | MIT |
| engine.io | 6.6.4 | MIT |
| engine.io-client | 6.6.3 | MIT |
| engine.io-parser | 5.2.3 | MIT |
| enhanced-resolve | 5.18.3 | MIT |
| enhanced-resolve | 5.19.0 | MIT |
| ent | 2.2.2 | MIT |
| entities | 1.1.2 | BSD-2-Clause |
| entities | 2.2.0 | BSD-2-Clause |
| entities | 4.5.0 | BSD-2-Clause |
| entities | 6.0.1 | BSD-2-Clause |
| env-paths | 2.2.1 | MIT |
| env-paths | 3.0.0 | MIT |
| err-code | 2.0.3 | MIT |
| error | 4.4.0 | MIT |
| error-ex | 1.3.4 | MIT |
| es-abstract | 1.24.0 | MIT |
| es-define-property | 1.0.1 | MIT |
| es-errors | 1.3.0 | MIT |
| es-iterator-helpers | 1.2.1 | MIT |
| es-module-lexer | 1.7.0 | MIT |
| es-module-lexer | 2.0.0 | MIT |
| es-object-atoms | 1.1.1 | MIT |
| es-set-tostringtag | 2.1.0 | MIT |
| es-shim-unscopables | 1.1.0 | MIT |
| es-to-primitive | 1.3.0 | MIT |
| es-toolkit | 1.39.10 | MIT |
| es6-error | 4.1.1 | MIT |
| es6-promise | 4.2.8 | MIT |
| es6-promisify | 5.0.0 | MIT |
| esbuild | 0.18.20 | MIT |
| esbuild | 0.19.12 | MIT |
| esbuild | 0.21.5 | MIT |
| esbuild | 0.25.10 | MIT |
| esbuild | 0.27.2 | MIT |
| esbuild-register | 3.6.0 | MIT |
| escalade | 3.2.0 | MIT |
| escape-html | 1.0.3 | MIT |
| escape-string-regexp | 2.0.0 | MIT |
| escape-string-regexp | 4.0.0 | MIT |
| escape-string-regexp | 5.0.0 | MIT |
| eslint | 9.36.0 | MIT |
| eslint-config-next | 15.3.9 | MIT |
| eslint-import-resolver-node | 0.3.9 | MIT |
| eslint-import-resolver-typescript | 3.10.1 | ISC |
| eslint-module-utils | 2.12.1 | MIT |
| eslint-plugin-import | 2.32.0 | MIT |
| eslint-plugin-jsx-a11y | 6.10.2 | MIT |
| eslint-plugin-react | 7.37.5 | MIT |
| eslint-plugin-react-hooks | 5.2.0 | MIT |
| eslint-scope | 5.1.1 | BSD-2-Clause |
| eslint-scope | 8.4.0 | BSD-2-Clause |
| eslint-visitor-keys | 3.4.3 | Apache-2.0 |
| eslint-visitor-keys | 4.2.1 | Apache-2.0 |
| espree | 10.4.0 | BSD-2-Clause |
| esprima | 4.0.1 | BSD-2-Clause |
| esquery | 1.6.0 | BSD-3-Clause |
| esrecurse | 4.3.0 | BSD-2-Clause |
| estraverse | 4.3.0 | BSD-2-Clause |
| estraverse | 5.3.0 | BSD-2-Clause |
| estree-util-is-identifier-name | 3.0.0 | MIT |
| estree-walker | 3.0.3 | MIT |
| esutils | 2.0.3 | BSD-2-Clause |
| etag | 1.8.1 | MIT |
| ev-store | 7.0.0 | MIT |
| event-target-shim | 5.0.1 | MIT |
| eventemitter3 | 4.0.7 | MIT |
| eventemitter3 | 5.0.1 | MIT |
| events | 3.3.0 | MIT |
| events-universal | 1.0.1 | Apache-2.0 |
| eventsource | 3.0.7 | MIT |
| eventsource-parser | 3.0.6 | MIT |
| execa | 5.1.1 | MIT |
| execa | 9.6.1 | MIT |
| expect | 30.1.2 | MIT |
| expect-type | 1.2.2 | Apache-2.0 |
| exponential-backoff | 3.1.3 | Apache-2.0 |
| express | 5.2.1 | MIT |
| express-rate-limit | 8.2.1 | MIT |
| exsolve | 1.0.7 | MIT |
| extend | 3.0.2 | MIT |
| extract-zip | 2.0.1 | BSD-2-Clause |
| fast-decode-uri-component | 1.0.1 | MIT |
| fast-deep-equal | 2.0.1 | MIT |
| fast-deep-equal | 3.1.3 | MIT |
| fast-equals | 5.4.0 | MIT |
| fast-fifo | 1.3.2 | MIT |
| fast-glob | 3.3.1 | MIT |
| fast-glob | 3.3.3 | MIT |
| fast-json-stable-stringify | 2.1.0 | MIT |
| fast-json-stringify | 6.3.0 | MIT |
| fast-levenshtein | 2.0.6 | MIT |
| fast-querystring | 1.1.2 | MIT |
| fast-safe-stringify | 2.1.1 | MIT |
| fast-uri | 3.1.0 | BSD-3-Clause |
| fastify | 5.8.2 | MIT |
| fastify-plugin | 5.1.0 | MIT |
| fastq | 1.19.1 | ISC |
| fd-package-json | 2.0.0 | MIT |
| fd-slicer | 1.1.0 | MIT |
| fdir | 6.5.0 | MIT |
| fetch-blob | 3.2.0 | MIT |
| fflate | 0.8.2 | MIT |
| figures | 6.1.0 | MIT |
| file-entry-cache | 8.0.0 | MIT |
| filelist | 1.0.4 | Apache-2.0 |
| fill-range | 7.1.1 | MIT |
| finalhandler | 2.1.1 | MIT |
| find-cache-dir | 2.1.0 | MIT |
| find-my-way | 9.5.0 | MIT |
| find-up | 3.0.0 | MIT |
| find-up | 5.0.0 | MIT |
| flat-cache | 4.0.1 | MIT |
| flatted | 3.3.3 | ISC |
| flow-parser | 0.289.0 | MIT |
| for-each | 0.3.5 | MIT |
| foreground-child | 3.3.1 | ISC |
| form-data | 4.0.4 | MIT |
| form-data | 4.0.5 | MIT |
| formatly | 0.3.0 | MIT |
| formdata-polyfill | 4.0.10 | MIT |
| formidable | 3.5.4 | MIT |
| forwarded | 0.2.0 | MIT |
| frac | 1.1.2 | Apache-2.0 |
| framer-motion | 12.23.22 | MIT |
| fresh | 2.0.0 | MIT |
| fs-extra | 10.1.0 | MIT |
| fs-extra | 11.3.2 | MIT |
| fs-extra | 11.3.3 | MIT |
| fs-extra | 7.0.1 | MIT |
| fs-extra | 8.1.0 | MIT |
| fs-extra | 9.1.0 | MIT |
| fs-minipass | 2.1.0 | ISC |
| fs.realpath | 1.0.0 | ISC |
| function-bind | 1.1.2 | MIT |
| function.prototype.name | 1.1.8 | MIT |
| functions-have-names | 1.2.3 | MIT |
| fuzzysort | 3.1.0 | MIT |
| fzf | 0.5.2 | BSD-3-Clause |
| gauge | 3.0.2 | ISC |
| gaxios | 7.1.2 | Apache-2.0 |
| gcp-metadata | 7.0.1 | Apache-2.0 |
| gensync | 1.0.0-beta.2 | MIT |
| get-caller-file | 2.0.5 | ISC |
| get-east-asian-width | 1.4.0 | MIT |
| get-intrinsic | 1.3.0 | MIT |
| get-nonce | 1.0.1 | MIT |
| get-own-enumerable-keys | 1.0.0 | MIT |
| get-proto | 1.0.1 | MIT |
| get-stream | 5.2.0 | MIT |
| get-stream | 6.0.1 | MIT |
| get-stream | 9.0.1 | MIT |
| get-symbol-description | 1.1.0 | MIT |
| get-tsconfig | 4.10.1 | MIT |
| glob | 10.4.5 | ISC |
| glob | 11.0.3 | ISC |
| glob | 13.0.0 | BlueOak-1.0.0 |
| glob | 7.2.3 | ISC |
| glob | 8.1.0 | ISC |
| glob-parent | 5.1.2 | ISC |
| glob-parent | 6.0.2 | ISC |
| glob-to-regexp | 0.4.1 | BSD-2-Clause |
| global | 4.4.0 | MIT |
| global-agent | 3.0.0 | BSD-3-Clause |
| globals | 14.0.0 | MIT |
| globalthis | 1.0.4 | MIT |
| globby | 14.1.0 | MIT |
| google-auth-library | 10.3.0 | Apache-2.0 |
| google-logging-utils | 1.1.1 | Apache-2.0 |
| google-protobuf | 3.21.4 | (BSD-3-Clause AND Apache-2.0) |
| gopd | 1.2.0 | MIT |
| got | 11.8.6 | MIT |
| graceful-fs | 4.2.11 | ISC |
| graphemer | 1.4.0 | MIT |
| graphql | 16.11.0 | MIT |
| gtoken | 8.0.0 | MIT |
| hachure-fill | 0.5.2 | MIT |
| has-bigints | 1.1.0 | MIT |
| has-flag | 4.0.0 | MIT |
| has-property-descriptors | 1.0.2 | MIT |
| has-proto | 1.2.0 | MIT |
| has-symbols | 1.1.0 | MIT |
| has-tostringtag | 1.0.2 | MIT |
| has-unicode | 2.0.1 | ISC |
| hasown | 2.0.2 | MIT |
| hast | 1.0.0 | MIT |
| hast-util-from-dom | 5.0.1 | ISC |
| hast-util-from-html | 2.0.3 | MIT |
| hast-util-from-html-isomorphic | 2.0.0 | MIT |
| hast-util-from-parse5 | 8.0.3 | MIT |
| hast-util-is-element | 3.0.0 | MIT |
| hast-util-parse-selector | 4.0.0 | MIT |
| hast-util-raw | 9.1.0 | MIT |
| hast-util-to-html | 9.0.5 | MIT |
| hast-util-to-jsx-runtime | 2.3.6 | MIT |
| hast-util-to-parse5 | 8.0.0 | MIT |
| hast-util-to-text | 4.0.2 | MIT |
| hast-util-whitespace | 3.0.0 | MIT |
| hastscript | 9.0.1 | MIT |
| headers-polyfill | 4.0.3 | MIT |
| hono | 4.11.9 | MIT |
| hosted-git-info | 4.1.0 | ISC |
| html-encoding-sniffer | 4.0.0 | MIT |
| html-entities | 2.6.0 | MIT |
| html-escaper | 2.0.2 | MIT |
| html-to-docx | 1.8.0 | MIT |
| html-to-text | 9.0.5 | MIT |
| html-to-vdom | 0.7.0 | ISC |
| html-url-attributes | 3.0.1 | MIT |
| html-void-elements | 3.0.0 | MIT |
| htmlparser2 | 10.0.0 | MIT |
| htmlparser2 | 3.10.1 | MIT |
| htmlparser2 | 8.0.2 | MIT |
| http-cache-semantics | 4.2.0 | BSD-2-Clause |
| http-errors | 2.0.0 | MIT |
| http-errors | 2.0.1 | MIT |
| http-proxy-agent | 5.0.0 | MIT |
| http-proxy-agent | 7.0.2 | MIT |
| http2-wrapper | 1.0.3 | MIT |
| https-proxy-agent | 2.2.4 | MIT |
| https-proxy-agent | 5.0.1 | MIT |
| https-proxy-agent | 7.0.6 | MIT |
| human-signals | 2.1.0 | Apache-2.0 |
| human-signals | 8.0.1 | Apache-2.0 |
| humanize-ms | 1.2.1 | MIT |
| iconv-lite | 0.6.3 | MIT |
| iconv-lite | 0.7.1 | MIT |
| idb-keyval | 6.2.2 | Apache-2.0 |
| ieee754 | 1.2.1 | BSD-3-Clause |
| ignore | 5.3.2 | MIT |
| ignore | 7.0.5 | MIT |
| image-size | 1.2.1 | MIT |
| image-to-base64 | 2.2.0 | MIT |
| immediate | 3.0.6 | MIT |
| immer | 10.1.3 | MIT |
| import-fresh | 3.3.1 | MIT |
| imurmurhash | 0.1.4 | MIT |
| indent-string | 4.0.0 | MIT |
| individual | 3.0.0 | MIT |
| infer-owner | 1.0.4 | ISC |
| inflight | 1.0.6 | ISC |
| inherits | 2.0.4 | ISC |
| ini | 4.1.3 | ISC |
| inline-style-parser | 0.2.4 | MIT |
| input-otp | 1.4.2 | MIT |
| internal-slot | 1.1.0 | MIT |
| internmap | 1.0.1 | ISC |
| internmap | 2.0.3 | ISC |
| ioredis | 5.8.0 | MIT |
| ip-address | 10.0.1 | MIT |
| ip-address | 10.1.0 | MIT |
| ipaddr.js | 1.9.1 | MIT |
| ipaddr.js | 2.3.0 | MIT |
| is-alphabetical | 2.0.1 | MIT |
| is-alphanumerical | 2.0.1 | MIT |
| is-array-buffer | 3.0.5 | MIT |
| is-arrayish | 0.2.1 | MIT |
| is-arrayish | 0.3.4 | MIT |
| is-async-function | 2.1.1 | MIT |
| is-bigint | 1.1.0 | MIT |
| is-boolean-object | 1.2.2 | MIT |
| is-bun-module | 2.0.0 | MIT |
| is-callable | 1.2.7 | MIT |
| is-ci | 3.0.1 | MIT |
| is-core-module | 2.16.1 | MIT |
| is-data-view | 1.0.2 | MIT |
| is-date-object | 1.1.0 | MIT |
| is-decimal | 2.0.1 | MIT |
| is-docker | 2.2.1 | MIT |
| is-docker | 3.0.0 | MIT |
| is-electron | 2.2.2 | MIT |
| is-extglob | 2.1.1 | MIT |
| is-finalizationregistry | 1.1.1 | MIT |
| is-fullwidth-code-point | 3.0.0 | MIT |
| is-generator-function | 1.1.0 | MIT |
| is-glob | 4.0.3 | MIT |
| is-hexadecimal | 2.0.1 | MIT |
| is-in-ssh | 1.0.0 | MIT |
| is-inside-container | 1.0.0 | MIT |
| is-interactive | 1.0.0 | MIT |
| is-interactive | 2.0.0 | MIT |
| is-lambda | 1.0.1 | MIT |
| is-map | 2.0.3 | MIT |
| is-negative-zero | 2.0.3 | MIT |
| is-node-process | 1.2.0 | MIT |
| is-number | 7.0.0 | MIT |
| is-number-object | 1.1.1 | MIT |
| is-obj | 3.0.0 | MIT |
| is-object | 1.0.2 | MIT |
| is-plain-obj | 4.1.0 | MIT |
| is-plain-object | 2.0.4 | MIT |
| is-potential-custom-element-name | 1.0.1 | MIT |
| is-promise | 4.0.0 | MIT |
| is-regex | 1.2.1 | MIT |
| is-regexp | 3.1.0 | MIT |
| is-set | 2.0.3 | MIT |
| is-shared-array-buffer | 1.0.4 | MIT |
| is-stream | 2.0.1 | MIT |
| is-stream | 4.0.1 | MIT |
| is-string | 1.1.1 | MIT |
| is-symbol | 1.1.1 | MIT |
| is-typed-array | 1.1.15 | MIT |
| is-unicode-supported | 0.1.0 | MIT |
| is-unicode-supported | 1.3.0 | MIT |
| is-unicode-supported | 2.1.0 | MIT |
| is-url | 1.2.4 | MIT |
| is-weakmap | 2.0.2 | MIT |
| is-weakref | 1.1.1 | MIT |
| is-weakset | 2.0.4 | MIT |
| is-wsl | 2.2.0 | MIT |
| is-wsl | 3.1.1 | MIT |
| isarray | 1.0.0 | MIT |
| isarray | 2.0.5 | MIT |
| isbinaryfile | 4.0.10 | MIT |
| isbinaryfile | 5.0.6 | MIT |
| isexe | 2.0.0 | ISC |
| isexe | 3.1.5 | BlueOak-1.0.0 |
| isobject | 3.0.1 | MIT |
| istanbul-lib-coverage | 3.2.2 | BSD-3-Clause |
| istanbul-lib-report | 3.0.1 | BSD-3-Clause |
| istanbul-lib-source-maps | 5.0.6 | BSD-3-Clause |
| istanbul-reports | 3.2.0 | BSD-3-Clause |
| iterator.prototype | 1.1.5 | MIT |
| jackspeak | 3.4.3 | BlueOak-1.0.0 |
| jackspeak | 4.1.1 | BlueOak-1.0.0 |
| jake | 10.9.4 | Apache-2.0 |
| jest-diff | 30.1.2 | MIT |
| jest-matcher-utils | 30.1.2 | MIT |
| jest-message-util | 30.1.0 | MIT |
| jest-mock | 30.0.5 | MIT |
| jest-regex-util | 30.0.1 | MIT |
| jest-util | 30.0.5 | MIT |
| jest-worker | 27.5.1 | MIT |
| jiti | 2.4.2 | MIT |
| jiti | 2.6.0 | MIT |
| jose | 6.1.3 | MIT |
| js-tokens | 4.0.0 | MIT |
| js-yaml | 4.1.0 | MIT |
| js-yaml | 4.1.1 | MIT |
| jscodeshift | 17.3.0 | MIT |
| jsdom | 25.0.1 | MIT |
| jsesc | 3.1.0 | MIT |
| json-bigint | 1.0.0 | MIT |
| json-buffer | 3.0.1 | MIT |
| json-parse-even-better-errors | 2.3.1 | MIT |
| json-schema | 0.4.0 | (AFL-2.1 OR BSD-3-Clause) |
| json-schema-ref-resolver | 3.0.0 | MIT |
| json-schema-traverse | 0.4.1 | MIT |
| json-schema-traverse | 1.0.0 | MIT |
| json-schema-typed | 8.0.1 | BSD-2-Clause |
| json-schema-typed | 8.0.2 | BSD-2-Clause |
| json-stable-stringify-without-jsonify | 1.0.1 | MIT |
| json-stringify-safe | 5.0.1 | ISC |
| json5 | 1.0.2 | MIT |
| json5 | 2.2.3 | MIT |
| jsonfile | 4.0.0 | MIT |
| jsonfile | 6.2.0 | MIT |
| jsonwebtoken | 9.0.3 | MIT |
| jsx-ast-utils | 3.3.5 | MIT |
| jszip | 3.10.1 | (MIT OR GPL-3.0-or-later) |
| jwa | 2.0.1 | MIT |
| jws | 4.0.0 | MIT |
| jws | 4.0.1 | MIT |
| katex | 0.16.25 | MIT |
| keyv | 4.5.4 | MIT |
| khroma | 2.1.0 | UNKNOWN |
| kind-of | 6.0.3 | MIT |
| kleur | 3.0.3 | MIT |
| kleur | 4.1.5 | MIT |
| knip | 5.70.2 | ISC |
| langium | 3.3.1 | MIT |
| language-subtag-registry | 0.3.23 | CC0-1.0 |
| language-tags | 1.0.9 | MIT |
| layout-base | 1.0.2 | MIT |
| layout-base | 2.0.1 | MIT |
| lazy-val | 1.0.5 | MIT |
| lazystream | 1.0.1 | MIT |
| leac | 0.6.0 | MIT |
| levn | 0.4.1 | MIT |
| lie | 3.3.0 | MIT |
| light-my-request | 6.6.0 | BSD-3-Clause |
| lightningcss | 1.30.1 | MPL-2.0 |
| lightningcss-linux-x64-gnu | 1.30.1 | MPL-2.0 |
| lightningcss-linux-x64-musl | 1.30.1 | MPL-2.0 |
| lines-and-columns | 1.2.4 | MIT |
| linkify-it | 5.0.0 | MIT |
| linkifyjs | 4.3.2 | MIT |
| loader-runner | 4.3.1 | MIT |
| locate-path | 3.0.0 | MIT |
| locate-path | 6.0.0 | MIT |
| lodash | 4.17.21 | MIT |
| lodash | 4.17.23 | MIT |
| lodash-es | 4.17.21 | MIT |
| lodash.defaults | 4.2.0 | MIT |
| lodash.escaperegexp | 4.1.2 | MIT |
| lodash.includes | 4.3.0 | MIT |
| lodash.isarguments | 3.1.0 | MIT |
| lodash.isboolean | 3.0.3 | MIT |
| lodash.isequal | 4.5.0 | MIT |
| lodash.isinteger | 4.0.4 | MIT |
| lodash.isnumber | 3.0.3 | MIT |
| lodash.isplainobject | 4.0.6 | MIT |
| lodash.isstring | 4.0.1 | MIT |
| lodash.merge | 4.6.2 | MIT |
| lodash.once | 4.1.1 | MIT |
| log-symbols | 4.1.0 | MIT |
| log-symbols | 6.0.0 | MIT |
| log-symbols | 7.0.1 | MIT |
| long | 4.0.0 | Apache-2.0 |
| longest-streak | 3.1.0 | MIT |
| loose-envify | 1.4.0 | MIT |
| lop | 0.4.2 | BSD-2-Clause |
| loupe | 3.2.1 | MIT |
| lowercase-keys | 2.0.0 | MIT |
| lru-cache | 10.4.3 | ISC |
| lru-cache | 11.2.2 | ISC |
| lru-cache | 5.1.1 | ISC |
| lru-cache | 6.0.0 | ISC |
| lru-cache | 7.18.3 | ISC |
| lucide-react | 0.525.0 | ISC |
| lucide-react | 0.542.0 | ISC |
| luxon | 3.7.2 | MIT |
| lz-string | 1.5.0 | MIT |
| magic-string | 0.30.19 | MIT |
| magicast | 0.3.5 | MIT |
| magika | 1.0.0 | Apache-2.0 |
| make-cancellable-promise | 2.0.0 | MIT |
| make-dir | 2.1.0 | MIT |
| make-dir | 3.1.0 | MIT |
| make-dir | 4.0.0 | MIT |
| make-error | 1.3.6 | ISC |
| make-event-props | 2.0.0 | MIT |
| make-fetch-happen | 10.2.1 | ISC |
| mammoth | 1.11.0 | BSD-2-Clause |
| markdown-it | 14.1.0 | MIT |
| markdown-it-task-lists | 2.1.1 | ISC |
| markdown-table | 3.0.4 | MIT |
| marked | 16.3.0 | MIT |
| marked | 17.0.1 | MIT |
| marked | 17.0.5 | MIT |
| marked | 7.0.4 | MIT |
| matcher | 3.0.0 | MIT |
| math-intrinsics | 1.1.0 | MIT |
| md-to-react-email | 5.0.5 | MIT |
| mdast-util-find-and-replace | 3.0.2 | MIT |
| mdast-util-from-markdown | 2.0.2 | MIT |
| mdast-util-gfm | 3.1.0 | MIT |
| mdast-util-gfm-autolink-literal | 2.0.1 | MIT |
| mdast-util-gfm-footnote | 2.1.0 | MIT |
| mdast-util-gfm-strikethrough | 2.0.0 | MIT |
| mdast-util-gfm-table | 2.0.0 | MIT |
| mdast-util-gfm-task-list-item | 2.0.0 | MIT |
| mdast-util-math | 3.0.0 | MIT |
| mdast-util-mdx-expression | 2.0.1 | MIT |
| mdast-util-mdx-jsx | 3.2.0 | MIT |
| mdast-util-mdxjs-esm | 2.0.1 | MIT |
| mdast-util-phrasing | 4.1.0 | MIT |
| mdast-util-to-hast | 13.2.1 | MIT |
| mdast-util-to-markdown | 2.1.2 | MIT |
| mdast-util-to-string | 4.0.0 | MIT |
| mdurl | 2.0.0 | MIT |
| media-typer | 0.3.0 | MIT |
| media-typer | 1.1.0 | MIT |
| merge-descriptors | 2.0.0 | MIT |
| merge-refs | 2.0.0 | MIT |
| merge-stream | 2.0.0 | MIT |
| merge2 | 1.4.1 | MIT |
| mermaid | 11.12.2 | MIT |
| methods | 1.1.2 | MIT |
| micromark | 4.0.2 | MIT |
| micromark-core-commonmark | 2.0.3 | MIT |
| micromark-extension-cjk-friendly | 1.2.3 | MIT |
| micromark-extension-cjk-friendly-gfm-strikethrough | 1.2.3 | MIT |
| micromark-extension-cjk-friendly-util | 2.1.1 | MIT |
| micromark-extension-gfm | 3.0.0 | MIT |
| micromark-extension-gfm-autolink-literal | 2.1.0 | MIT |
| micromark-extension-gfm-footnote | 2.1.0 | MIT |
| micromark-extension-gfm-strikethrough | 2.1.0 | MIT |
| micromark-extension-gfm-table | 2.1.1 | MIT |
| micromark-extension-gfm-tagfilter | 2.0.0 | MIT |
| micromark-extension-gfm-task-list-item | 2.1.0 | MIT |
| micromark-extension-math | 3.1.0 | MIT |
| micromark-factory-destination | 2.0.1 | MIT |
| micromark-factory-label | 2.0.1 | MIT |
| micromark-factory-space | 2.0.1 | MIT |
| micromark-factory-title | 2.0.1 | MIT |
| micromark-factory-whitespace | 2.0.1 | MIT |
| micromark-util-character | 2.1.1 | MIT |
| micromark-util-chunked | 2.0.1 | MIT |
| micromark-util-classify-character | 2.0.1 | MIT |
| micromark-util-combine-extensions | 2.0.1 | MIT |
| micromark-util-decode-numeric-character-reference | 2.0.2 | MIT |
| micromark-util-decode-string | 2.0.1 | MIT |
| micromark-util-encode | 2.0.1 | MIT |
| micromark-util-html-tag-name | 2.0.1 | MIT |
| micromark-util-normalize-identifier | 2.0.1 | MIT |
| micromark-util-resolve-all | 2.0.1 | MIT |
| micromark-util-sanitize-uri | 2.0.1 | MIT |
| micromark-util-subtokenize | 2.1.0 | MIT |
| micromark-util-symbol | 2.0.1 | MIT |
| micromark-util-types | 2.0.2 | MIT |
| micromatch | 4.0.8 | MIT |
| mime | 2.6.0 | MIT |
| mime-db | 1.52.0 | MIT |
| mime-db | 1.54.0 | MIT |
| mime-types | 2.1.35 | MIT |
| mime-types | 3.0.1 | MIT |
| mime-types | 3.0.2 | MIT |
| mimic-fn | 2.1.0 | MIT |
| mimic-function | 5.0.1 | MIT |
| mimic-response | 1.0.1 | MIT |
| mimic-response | 3.1.0 | MIT |
| min-document | 2.19.0 | MIT |
| min-indent | 1.0.1 | MIT |
| minimatch | 10.0.3 | ISC |
| minimatch | 10.1.1 | BlueOak-1.0.0 |
| minimatch | 3.1.2 | ISC |
| minimatch | 3.1.3 | ISC |
| minimatch | 5.1.6 | ISC |
| minimatch | 5.1.7 | ISC |
| minimatch | 9.0.5 | ISC |
| minimist | 1.2.8 | MIT |
| minipass | 3.3.6 | ISC |
| minipass | 5.0.0 | ISC |
| minipass | 7.1.2 | ISC |
| minipass-collect | 1.0.2 | ISC |
| minipass-fetch | 2.1.2 | MIT |
| minipass-flush | 1.0.5 | ISC |
| minipass-pipeline | 1.2.4 | ISC |
| minipass-sized | 1.0.3 | ISC |
| minizlib | 2.1.2 | MIT |
| minizlib | 3.1.0 | MIT |
| mkdirp | 0.5.6 | MIT |
| mkdirp | 1.0.4 | MIT |
| mlly | 1.8.0 | MIT |
| monaco-editor | 0.52.2 | MIT |
| motion | 12.23.22 | MIT |
| motion-dom | 12.23.21 | MIT |
| motion-utils | 12.23.6 | MIT |
| mrmime | 2.0.1 | MIT |
| ms | 2.1.3 | MIT |
| msw | 2.11.3 | MIT |
| multer | 1.4.5-lts.2 | MIT |
| mute-stream | 2.0.0 | ISC |
| nanoid | 3.3.11 | MIT |
| napi-postinstall | 0.3.3 | MIT |
| native-run | 2.0.3 | MIT |
| natural-compare | 1.4.0 | MIT |
| negotiator | 0.6.3 | MIT |
| negotiator | 0.6.4 | MIT |
| negotiator | 1.0.0 | MIT |
| neo-async | 2.6.2 | MIT |
| next | 15.3.9 | MIT |
| next | 16.0.10 | MIT |
| next-themes | 0.4.6 | MIT |
| next-tick | 0.2.2 | MIT |
| next-ws | 2.1.5 | MIT |
| node-abi | 3.78.0 | MIT |
| node-api-version | 0.2.1 | MIT |
| node-domexception | 1.0.0 | MIT |
| node-ensure | 0.0.0 | MIT |
| node-fetch | 2.6.13 | MIT |
| node-fetch | 2.7.0 | MIT |
| node-fetch | 3.3.2 | MIT |
| node-machine-id | 1.1.12 | MIT |
| node-releases | 2.0.21 | MIT |
| node-releases | 2.0.27 | MIT |
| node-rsa | 1.1.1 | MIT |
| nopt | 5.0.0 | ISC |
| nopt | 6.0.0 | ISC |
| normalize-path | 3.0.0 | MIT |
| normalize-url | 6.1.0 | MIT |
| npm-run-path | 4.0.1 | MIT |
| npm-run-path | 6.0.0 | MIT |
| npmlog | 5.0.1 | ISC |
| nth-check | 2.1.1 | BSD-2-Clause |
| nwsapi | 2.2.22 | MIT |
| nypm | 0.6.2 | MIT |
| object-assign | 4.1.1 | MIT |
| object-inspect | 1.13.4 | MIT |
| object-keys | 1.1.1 | MIT |
| object-treeify | 1.1.33 | MIT |
| object.assign | 4.1.7 | MIT |
| object.entries | 1.1.9 | MIT |
| object.fromentries | 2.0.8 | MIT |
| object.groupby | 1.0.3 | MIT |
| object.values | 1.2.1 | MIT |
| ollama-ai-provider-v2 | 1.3.1 | Apache-2.0 |
| on-exit-leak-free | 2.1.2 | MIT |
| on-finished | 2.4.1 | MIT |
| once | 1.4.0 | ISC |
| onetime | 5.1.2 | MIT |
| onetime | 7.0.0 | MIT |
| oniguruma-parser | 0.12.1 | MIT |
| oniguruma-to-es | 4.3.4 | MIT |
| open | 11.0.0 | MIT |
| open | 8.4.2 | MIT |
| opencollective-postinstall | 2.0.3 | MIT |
| option | 0.2.4 | BSD-2-Clause |
| optionator | 0.9.4 | MIT |
| ora | 5.4.1 | MIT |
| ora | 8.2.0 | MIT |
| orderedmap | 2.1.1 | MIT |
| outvariant | 1.4.3 | MIT |
| own-keys | 1.0.1 | MIT |
| oxc-resolver | 11.14.0 | MIT |
| p-cancelable | 2.1.1 | MIT |
| p-limit | 2.3.0 | MIT |
| p-limit | 3.1.0 | MIT |
| p-locate | 3.0.0 | MIT |
| p-locate | 5.0.0 | MIT |
| p-map | 4.0.0 | MIT |
| p-try | 2.2.0 | MIT |
| package-json-from-dist | 1.0.1 | BlueOak-1.0.0 |
| package-manager-detector | 1.6.0 | MIT |
| pako | 1.0.11 | (MIT AND Zlib) |
| pako | 2.1.0 | (MIT AND Zlib) |
| parent-module | 1.0.1 | MIT |
| parse-entities | 4.0.2 | MIT |
| parse-json | 5.2.0 | MIT |
| parse-ms | 4.0.0 | MIT |
| parse5 | 7.3.0 | MIT |
| parse5-htmlparser2-tree-adapter | 7.1.0 | MIT |
| parse5-parser-stream | 7.1.2 | MIT |
| parseley | 0.12.1 | MIT |
| parseurl | 1.3.3 | MIT |
| path-browserify | 1.0.1 | MIT |
| path-data-parser | 0.1.0 | MIT |
| path-exists | 3.0.0 | MIT |
| path-exists | 4.0.0 | MIT |
| path-is-absolute | 1.0.1 | MIT |
| path-key | 3.1.1 | MIT |
| path-key | 4.0.0 | MIT |
| path-parse | 1.0.7 | MIT |
| path-scurry | 1.11.1 | BlueOak-1.0.0 |
| path-scurry | 2.0.0 | BlueOak-1.0.0 |
| path-to-regexp | 6.3.0 | MIT |
| path-to-regexp | 8.3.0 | MIT |
| path-type | 6.0.0 | MIT |
| pathe | 1.1.2 | MIT |
| pathe | 2.0.3 | MIT |
| pathval | 2.0.1 | MIT |
| pdf-parse-debugging-disabled | 1.1.1 | MIT |
| pdfjs-dist | 4.10.38 | Apache-2.0 |
| pdfjs-dist | 5.3.93 | Apache-2.0 |
| pe-library | 0.4.1 | MIT |
| peberminta | 0.9.0 | MIT |
| pend | 1.2.0 | MIT |
| pg | 8.16.3 | MIT |
| pg-boss | 10.3.3 | MIT |
| pg-cloudflare | 1.2.7 | MIT |
| pg-connection-string | 2.9.1 | MIT |
| pg-int8 | 1.0.1 | ISC |
| pg-pool | 3.10.1 | MIT |
| pg-protocol | 1.10.3 | MIT |
| pg-types | 2.2.0 | MIT |
| pgpass | 1.0.5 | MIT |
| picocolors | 1.1.1 | ISC |
| picomatch | 2.3.1 | MIT |
| picomatch | 4.0.3 | MIT |
| pify | 4.0.1 | MIT |
| pino | 10.3.1 | MIT |
| pino-abstract-transport | 3.0.0 | MIT |
| pino-std-serializers | 7.1.0 | MIT |
| pirates | 4.0.7 | MIT |
| pkce-challenge | 5.0.1 | MIT |
| pkg-dir | 3.0.0 | MIT |
| pkg-types | 1.3.1 | MIT |
| pkg-types | 2.3.0 | MIT |
| playwright | 1.55.1 | Apache-2.0 |
| playwright-core | 1.55.1 | Apache-2.0 |
| plist | 3.1.0 | MIT |
| points-on-curve | 0.2.0 | MIT |
| points-on-path | 0.2.1 | MIT |
| possible-typed-array-names | 1.1.0 | MIT |
| postcss | 8.4.31 | MIT |
| postcss | 8.5.6 | MIT |
| postcss-selector-parser | 6.0.10 | MIT |
| postcss-selector-parser | 7.1.1 | MIT |
| postgres | 3.4.8 | Unlicense |
| postgres-array | 2.0.0 | MIT |
| postgres-bytea | 1.0.0 | MIT |
| postgres-date | 1.0.7 | MIT |
| postgres-interval | 1.2.0 | MIT |
| postject | 1.0.0-alpha.6 | MIT |
| powershell-utils | 0.1.0 | MIT |
| prelude-ls | 1.2.1 | MIT |
| prettier | 3.6.2 | MIT |
| pretty-format | 27.5.1 | MIT |
| pretty-format | 30.0.5 | MIT |
| pretty-ms | 9.3.0 | MIT |
| prismjs | 1.30.0 | MIT |
| proc-log | 2.0.1 | ISC |
| process | 0.11.10 | MIT |
| process-nextick-args | 2.0.1 | MIT |
| process-warning | 4.0.1 | MIT |
| process-warning | 5.0.0 | MIT |
| progress | 2.0.3 | MIT |
| promise-inflight | 1.0.1 | ISC |
| promise-retry | 2.0.1 | MIT |
| prompts | 2.4.2 | MIT |
| prop-types | 15.8.1 | MIT |
| property-information | 6.5.0 | MIT |
| property-information | 7.1.0 | MIT |
| prosemirror-changeset | 2.3.1 | MIT |
| prosemirror-collab | 1.3.1 | MIT |
| prosemirror-commands | 1.7.1 | MIT |
| prosemirror-dropcursor | 1.8.2 | MIT |
| prosemirror-gapcursor | 1.3.2 | MIT |
| prosemirror-history | 1.4.1 | MIT |
| prosemirror-inputrules | 1.5.0 | MIT |
| prosemirror-keymap | 1.2.3 | MIT |
| prosemirror-markdown | 1.13.2 | MIT |
| prosemirror-menu | 1.2.5 | MIT |
| prosemirror-model | 1.25.3 | MIT |
| prosemirror-schema-basic | 1.2.4 | MIT |
| prosemirror-schema-list | 1.5.1 | MIT |
| prosemirror-state | 1.4.3 | MIT |
| prosemirror-tables | 1.8.1 | MIT |
| prosemirror-trailing-node | 3.0.0 | MIT |
| prosemirror-transform | 1.10.4 | MIT |
| prosemirror-view | 1.41.1 | MIT |
| proxy-addr | 2.0.7 | MIT |
| pump | 3.0.3 | MIT |
| punycode | 1.4.1 | MIT |
| punycode | 2.3.1 | MIT |
| punycode.js | 2.3.1 | MIT |
| pvtsutils | 1.3.6 | MIT |
| pvutils | 1.1.5 | MIT |
| qs | 6.14.0 | BSD-3-Clause |
| qs | 6.14.1 | BSD-3-Clause |
| queue | 6.0.2 | MIT |
| queue-microtask | 1.2.3 | MIT |
| quick-format-unescaped | 4.0.4 | MIT |
| quick-lru | 5.1.1 | MIT |
| radix-ui | 1.4.3 | MIT |
| randombytes | 2.1.0 | MIT |
| range-parser | 1.2.1 | MIT |
| raw-body | 3.0.2 | MIT |
| react | 19.2.1 | MIT |
| react-day-picker | 9.11.3 | MIT |
| react-day-picker | 9.13.2 | MIT |
| react-dom | 19.2.1 | MIT |
| react-email | 5.1.1 | MIT |
| react-hook-form | 7.63.0 | MIT |
| react-image-crop | 11.0.10 | ISC |
| react-is | 16.13.1 | MIT |
| react-is | 17.0.2 | MIT |
| react-is | 18.3.1 | MIT |
| react-markdown | 10.1.0 | MIT |
| react-pdf | 10.1.0 | MIT |
| react-promise-suspense | 0.3.4 | MIT |
| react-reconciler | 0.33.0 | MIT |
| react-redux | 9.2.0 | MIT |
| react-refresh | 0.17.0 | MIT |
| react-remove-scroll | 2.7.1 | MIT |
| react-remove-scroll-bar | 2.3.8 | MIT |
| react-resizable-panels | 4.6.4 | MIT |
| react-smooth | 4.0.4 | MIT |
| react-style-singleton | 2.2.3 | MIT |
| react-transition-group | 4.4.5 | BSD-3-Clause |
| read-binary-file-arch | 1.0.6 | MIT |
| readable-stream | 2.3.8 | MIT |
| readable-stream | 3.6.2 | MIT |
| readable-stream | 4.7.0 | MIT |
| readdir-glob | 1.1.3 | Apache-2.0 |
| readdirp | 4.1.2 | MIT |
| real-require | 0.2.0 | MIT |
| recast | 0.23.11 | MIT |
| recharts | 2.15.4 | MIT |
| recharts | 3.2.1 | MIT |
| recharts-scale | 0.4.5 | MIT |
| redent | 3.0.0 | MIT |
| redis-errors | 1.2.0 | MIT |
| redis-parser | 3.0.0 | MIT |
| redux | 5.0.1 | MIT |
| redux-thunk | 3.1.0 | MIT |
| reflect-metadata | 0.2.2 | Apache-2.0 |
| reflect.getprototypeof | 1.0.10 | MIT |
| regenerator-runtime | 0.13.11 | MIT |
| regex | 6.0.1 | MIT |
| regex-recursion | 6.0.2 | MIT |
| regex-utilities | 2.3.0 | MIT |
| regexp.prototype.flags | 1.5.4 | MIT |
| rehype-harden | 1.1.6 | MIT |
| rehype-katex | 7.0.1 | MIT |
| rehype-raw | 7.0.0 | MIT |
| remark-cjk-friendly | 1.2.3 | MIT |
| remark-cjk-friendly-gfm-strikethrough | 1.2.3 | MIT |
| remark-gfm | 4.0.1 | MIT |
| remark-math | 6.0.0 | MIT |
| remark-parse | 11.0.0 | MIT |
| remark-rehype | 11.1.2 | MIT |
| remark-stringify | 11.0.0 | MIT |
| require-directory | 2.1.1 | MIT |
| require-from-string | 2.0.2 | MIT |
| resedit | 1.7.2 | MIT |
| reselect | 5.1.1 | MIT |
| resend | 6.1.2 | MIT |
| resolve | 1.22.10 | MIT |
| resolve | 2.0.0-next.5 | MIT |
| resolve-alpn | 1.2.1 | MIT |
| resolve-from | 4.0.0 | MIT |
| resolve-pkg-maps | 1.0.0 | MIT |
| responselike | 2.0.1 | MIT |
| restore-cursor | 3.1.0 | MIT |
| restore-cursor | 5.1.0 | MIT |
| ret | 0.5.0 | MIT |
| retry | 0.12.0 | MIT |
| rettime | 0.7.0 | MIT |
| reusify | 1.1.0 | MIT |
| rfdc | 1.4.1 | MIT |
| rimraf | 2.6.3 | ISC |
| rimraf | 3.0.2 | ISC |
| rimraf | 6.1.2 | BlueOak-1.0.0 |
| roarr | 2.15.4 | BSD-3-Clause |
| robust-predicates | 3.0.2 | Unlicense |
| rollup | 4.52.3 | MIT |
| rope-sequence | 1.3.4 | MIT |
| roughjs | 4.6.6 | MIT |
| router | 2.2.0 | MIT |
| rrweb-cssom | 0.7.1 | MIT |
| rrweb-cssom | 0.8.0 | MIT |
| run-applescript | 7.1.0 | MIT |
| run-parallel | 1.2.0 | MIT |
| rw | 1.3.3 | BSD-3-Clause |
| safe-array-concat | 1.1.3 | MIT |
| safe-buffer | 5.1.2 | MIT |
| safe-buffer | 5.2.1 | MIT |
| safe-push-apply | 1.0.0 | MIT |
| safe-regex-test | 1.1.0 | MIT |
| safe-regex2 | 5.1.0 | MIT |
| safe-stable-stringify | 2.5.0 | MIT |
| safer-buffer | 2.1.2 | MIT |
| sanitize-filename | 1.6.3 | WTFPL OR ISC |
| sax | 1.1.4 | ISC |
| sax | 1.4.1 | ISC |
| saxes | 6.0.0 | ISC |
| scheduler | 0.27.0 | MIT |
| schema-utils | 4.3.2 | MIT |
| schema-utils | 4.3.3 | MIT |
| secure-json-parse | 4.1.0 | BSD-3-Clause |
| seedrandom | 3.0.5 | MIT |
| selderee | 0.11.0 | MIT |
| semver | 5.7.2 | ISC |
| semver | 6.3.1 | ISC |
| semver | 7.7.2 | ISC |
| semver-compare | 1.0.0 | MIT |
| send | 1.2.1 | MIT |
| serialize-error | 7.0.1 | MIT |
| serialize-error | 8.1.0 | MIT |
| serialize-javascript | 6.0.2 | BSD-3-Clause |
| serve-static | 2.2.1 | MIT |
| server-only | 0.0.1 | MIT |
| set-blocking | 2.0.0 | ISC |
| set-cookie-parser | 2.7.2 | MIT |
| set-function-length | 1.2.2 | MIT |
| set-function-name | 2.0.2 | MIT |
| set-proto | 1.0.0 | MIT |
| setimmediate | 1.0.5 | MIT |
| setprototypeof | 1.2.0 | ISC |
| shadcn | 3.8.5 | MIT |
| shallow-clone | 3.0.1 | MIT |
| sharp | 0.33.5 | Apache-2.0 |
| sharp | 0.34.4 | Apache-2.0 |
| shebang-command | 2.0.0 | MIT |
| shebang-regex | 3.0.0 | MIT |
| shiki | 3.22.0 | MIT |
| side-channel | 1.1.0 | MIT |
| side-channel-list | 1.0.0 | MIT |
| side-channel-map | 1.0.1 | MIT |
| side-channel-weakmap | 1.0.2 | MIT |
| siginfo | 2.0.0 | ISC |
| signal-exit | 3.0.7 | ISC |
| signal-exit | 4.1.0 | ISC |
| simple-swizzle | 0.2.4 | MIT |
| simple-update-notifier | 2.0.0 | MIT |
| sirv | 3.0.2 | MIT |
| sisteransi | 1.0.5 | MIT |
| slash | 3.0.0 | MIT |
| slash | 5.1.0 | MIT |
| slice-ansi | 4.0.0 | MIT |
| smart-buffer | 4.2.0 | MIT |
| smol-toml | 1.5.2 | BSD-3-Clause |
| socket.io | 4.8.1 | MIT |
| socket.io-adapter | 2.5.5 | MIT |
| socket.io-client | 4.8.1 | MIT |
| socket.io-parser | 4.2.4 | MIT |
| socks | 2.8.7 | MIT |
| socks-proxy-agent | 7.0.0 | MIT |
| sonic-boom | 4.2.1 | MIT |
| sonner | 2.0.7 | MIT |
| source-map | 0.6.1 | BSD-3-Clause |
| source-map-js | 1.2.1 | BSD-3-Clause |
| source-map-support | 0.5.21 | MIT |
| space-separated-tokens | 2.0.2 | MIT |
| split2 | 4.2.0 | ISC |
| sprintf-js | 1.0.3 | BSD-3-Clause |
| sprintf-js | 1.1.3 | BSD-3-Clause |
| ssf | 0.11.2 | Apache-2.0 |
| ssri | 9.0.1 | ISC |
| stable-hash | 0.0.5 | MIT |
| stack-utils | 2.0.6 | MIT |
| stackback | 0.0.2 | MIT |
| standard-as-callback | 2.1.0 | MIT |
| stat-mode | 1.0.0 | MIT |
| state-local | 1.0.7 | MIT |
| statuses | 2.0.1 | MIT |
| statuses | 2.0.2 | MIT |
| std-env | 3.9.0 | MIT |
| stdin-discarder | 0.2.2 | MIT |
| stop-iteration-iterator | 1.1.0 | MIT |
| streamdown | 1.6.9 | Apache-2.0 |
| streamsearch | 1.1.0 | MIT |
| streamx | 2.23.0 | MIT |
| strict-event-emitter | 0.5.1 | MIT |
| string_decoder | 1.1.1 | MIT |
| string_decoder | 1.3.0 | MIT |
| string-template | 0.2.1 | MIT |
| string-width | 4.2.3 | MIT |
| string-width | 5.1.2 | MIT |
| string-width | 7.2.0 | MIT |
| string.prototype.includes | 2.0.1 | MIT |
| string.prototype.matchall | 4.0.12 | MIT |
| string.prototype.repeat | 1.0.0 | MIT |
| string.prototype.trim | 1.2.10 | MIT |
| string.prototype.trimend | 1.0.9 | MIT |
| string.prototype.trimstart | 1.0.8 | MIT |
| stringify-entities | 4.0.4 | MIT |
| stringify-object | 5.0.0 | BSD-2-Clause |
| strip-ansi | 6.0.1 | MIT |
| strip-ansi | 7.1.2 | MIT |
| strip-bom | 3.0.0 | MIT |
| strip-final-newline | 2.0.0 | MIT |
| strip-final-newline | 4.0.0 | MIT |
| strip-indent | 3.0.0 | MIT |
| strip-json-comments | 3.1.1 | MIT |
| strip-json-comments | 5.0.3 | MIT |
| stripe | 20.1.0 | MIT |
| stubborn-fs | 1.2.5 | UNKNOWN |
| style-to-js | 1.1.17 | MIT |
| style-to-object | 1.0.9 | MIT |
| styled-jsx | 5.1.6 | MIT |
| stylis | 4.3.6 | MIT |
| sumchecker | 3.0.1 | Apache-2.0 |
| superagent | 10.3.0 | MIT |
| supertest | 7.2.2 | MIT |
| supports-color | 7.2.0 | MIT |
| supports-color | 8.1.1 | MIT |
| supports-preserve-symlinks-flag | 1.0.0 | MIT |
| swr | 2.3.6 | MIT |
| symbol-tree | 3.2.4 | MIT |
| tabbable | 6.4.0 | MIT |
| tagged-tag | 1.0.0 | MIT |
| tailwind-merge | 3.3.1 | MIT |
| tailwindcss | 4.1.13 | MIT |
| tapable | 2.2.3 | MIT |
| tapable | 2.3.0 | MIT |
| tar | 6.2.1 | ISC |
| tar | 7.5.1 | ISC |
| tar-stream | 3.1.7 | MIT |
| temp | 0.9.4 | MIT |
| temp-file | 3.4.0 | MIT |
| terser | 5.44.0 | BSD-2-Clause |
| terser-webpack-plugin | 5.3.16 | MIT |
| tesseract.js | 5.1.1 | Apache-2.0 |
| tesseract.js-core | 5.1.1 | Apache-2.0 |
| test-exclude | 7.0.1 | ISC |
| text-decoder | 1.2.3 | Apache-2.0 |
| thread-stream | 4.0.0 | MIT |
| throttleit | 2.1.0 | MIT |
| through2 | 4.0.2 | MIT |
| tiny-async-pool | 1.3.0 | MIT |
| tiny-invariant | 1.3.3 | MIT |
| tiny-typed-emitter | 2.1.0 | MIT |
| tinybench | 2.9.0 | MIT |
| tinyexec | 0.3.2 | MIT |
| tinyexec | 1.0.2 | MIT |
| tinyglobby | 0.2.15 | MIT |
| tinypool | 1.1.1 | MIT |
| tinyrainbow | 1.2.0 | MIT |
| tinyspy | 3.0.2 | MIT |
| tippy.js | 6.3.7 | MIT |
| tiptap-markdown | 0.8.10 | MIT |
| tldts | 6.1.86 | MIT |
| tldts | 7.0.16 | MIT |
| tldts-core | 6.1.86 | MIT |
| tldts-core | 7.0.16 | MIT |
| tmp | 0.2.5 | MIT |
| tmp-promise | 3.0.3 | MIT |
| to-regex-range | 5.0.1 | MIT |
| toad-cache | 3.7.0 | MIT |
| toidentifier | 1.0.1 | MIT |
| tokenlens | 1.3.1 | MIT |
| totalist | 3.0.1 | MIT |
| tough-cookie | 5.1.2 | BSD-3-Clause |
| tough-cookie | 6.0.0 | BSD-3-Clause |
| tr46 | 0.0.3 | MIT |
| tr46 | 5.1.1 | MIT |
| tree-kill | 1.2.2 | MIT |
| trim-lines | 3.0.1 | MIT |
| trough | 2.2.0 | MIT |
| truncate-utf8-bytes | 1.0.2 | WTFPL |
| ts-api-utils | 2.1.0 | MIT |
| ts-dedent | 2.2.0 | MIT |
| ts-morph | 26.0.0 | MIT |
| ts-node | 10.9.2 | MIT |
| tsconfig-paths | 3.15.0 | MIT |
| tsconfig-paths | 4.2.0 | MIT |
| tslib | 1.14.1 | 0BSD |
| tslib | 2.8.1 | 0BSD |
| tsx | 4.20.6 | MIT |
| tsx | 4.21.0 | MIT |
| tsyringe | 4.10.0 | MIT |
| turbo | 2.5.8 | MIT |
| turbo-linux-64 | 2.5.8 | MIT |
| turndown | 7.2.2 | MIT |
| tw-animate-css | 1.4.0 | MIT |
| type-check | 0.4.0 | MIT |
| type-fest | 0.13.1 | (MIT OR CC0-1.0) |
| type-fest | 0.20.2 | (MIT OR CC0-1.0) |
| type-fest | 4.41.0 | (MIT OR CC0-1.0) |
| type-fest | 5.3.1 | (MIT OR CC0-1.0) |
| type-is | 1.6.18 | MIT |
| type-is | 2.0.1 | MIT |
| typed-array-buffer | 1.0.3 | MIT |
| typed-array-byte-length | 1.0.3 | MIT |
| typed-array-byte-offset | 1.0.4 | MIT |
| typed-array-length | 1.0.7 | MIT |
| typedarray | 0.0.6 | MIT |
| typescript | 5.8.3 | Apache-2.0 |
| typescript | 5.9.2 | Apache-2.0 |
| uc.micro | 2.1.0 | MIT |
| ufo | 1.6.1 | MIT |
| uint8array-extras | 1.5.0 | MIT |
| unbox-primitive | 1.1.0 | MIT |
| underscore | 1.13.7 | MIT |
| undici | 7.16.0 | MIT |
| undici-types | 6.21.0 | MIT |
| undici-types | 7.12.0 | MIT |
| unicorn-magic | 0.3.0 | MIT |
| unified | 11.0.5 | MIT |
| unique-filename | 2.0.1 | ISC |
| unique-slug | 3.0.0 | ISC |
| unist-util-find-after | 5.0.0 | MIT |
| unist-util-is | 6.0.0 | MIT |
| unist-util-position | 5.0.0 | MIT |
| unist-util-remove-position | 5.0.0 | MIT |
| unist-util-stringify-position | 4.0.0 | MIT |
| unist-util-visit | 5.0.0 | MIT |
| unist-util-visit-parents | 6.0.1 | MIT |
| universalify | 0.1.2 | MIT |
| universalify | 2.0.1 | MIT |
| unpipe | 1.0.0 | MIT |
| unrs-resolver | 1.11.1 | MIT |
| until-async | 3.0.2 | MIT |
| untildify | 4.0.0 | MIT |
| update-browserslist-db | 1.1.3 | MIT |
| update-browserslist-db | 1.2.3 | MIT |
| uri-js | 4.4.1 | BSD-2-Clause |
| use-callback-ref | 1.3.3 | MIT |
| use-debounce | 10.0.6 | MIT |
| use-sidecar | 1.1.3 | MIT |
| use-stick-to-bottom | 1.1.1 | MIT |
| use-sync-external-store | 1.5.0 | MIT |
| use-sync-external-store | 1.6.0 | MIT |
| utf8-byte-length | 1.0.5 | (WTFPL OR MIT) |
| util-deprecate | 1.0.2 | MIT |
| uuid | 11.1.0 | MIT |
| v8-compile-cache-lib | 3.0.1 | MIT |
| validate-npm-package-name | 7.0.2 | ISC |
| vary | 1.1.2 | MIT |
| vaul | 1.1.2 | MIT |
| vfile | 6.0.3 | MIT |
| vfile-location | 5.0.3 | MIT |
| vfile-message | 4.0.3 | MIT |
| victory-vendor | 36.9.2 | MIT AND ISC |
| victory-vendor | 37.3.6 | MIT AND ISC |
| virtual-dom | 2.1.1 | MIT |
| vite | 5.4.20 | MIT |
| vite | 6.4.2 | MIT |
| vite-node | 2.1.9 | MIT |
| vitest | 2.1.9 | MIT |
| vscode-jsonrpc | 8.2.0 | MIT |
| vscode-languageserver | 9.0.1 | MIT |
| vscode-languageserver-protocol | 3.17.5 | MIT |
| vscode-languageserver-textdocument | 1.0.12 | MIT |
| vscode-languageserver-types | 3.17.5 | MIT |
| vscode-uri | 3.0.8 | MIT |
| w3c-keyname | 2.2.8 | MIT |
| w3c-xmlserializer | 5.0.0 | MIT |
| walk-up-path | 4.0.0 | ISC |
| warning | 4.0.3 | MIT |
| wasm-feature-detect | 1.8.0 | Apache-2.0 |
| watchpack | 2.5.1 | MIT |
| wcwidth | 1.0.1 | MIT |
| web-namespaces | 2.0.1 | MIT |
| web-streams-polyfill | 3.3.3 | MIT |
| webidl-conversions | 3.0.1 | BSD-2-Clause |
| webidl-conversions | 7.0.0 | BSD-2-Clause |
| webpack | 5.105.0 | MIT |
| webpack-sources | 3.3.3 | MIT |
| whatwg-encoding | 3.1.1 | MIT |
| whatwg-mimetype | 4.0.0 | MIT |
| whatwg-url | 14.2.0 | MIT |
| whatwg-url | 5.0.0 | MIT |
| when-exit | 2.1.4 | MIT |
| which | 2.0.2 | ISC |
| which | 4.0.0 | ISC |
| which-boxed-primitive | 1.1.1 | MIT |
| which-builtin-type | 1.2.1 | MIT |
| which-collection | 1.0.2 | MIT |
| which-typed-array | 1.1.19 | MIT |
| why-is-node-running | 2.3.0 | MIT |
| wide-align | 1.1.5 | ISC |
| wmf | 1.0.2 | Apache-2.0 |
| word | 0.3.0 | Apache-2.0 |
| word-wrap | 1.2.5 | MIT |
| wrap-ansi | 6.2.0 | MIT |
| wrap-ansi | 7.0.0 | MIT |
| wrap-ansi | 8.1.0 | MIT |
| wrappy | 1.0.2 | ISC |
| write-file-atomic | 5.0.1 | ISC |
| ws | 8.17.1 | MIT |
| ws | 8.18.3 | MIT |
| wsl-utils | 0.3.1 | MIT |
| x-is-array | 0.1.0 | MIT |
| x-is-string | 0.1.0 | MIT |
| xlsx | 0.18.5 | Apache-2.0 |
| xml-name-validator | 5.0.0 | Apache-2.0 |
| xml2js | 0.6.2 | MIT |
| xmlbuilder | 10.1.1 | MIT |
| xmlbuilder | 11.0.1 | MIT |
| xmlbuilder | 15.1.1 | MIT |
| xmlbuilder2 | 2.1.2 | MIT |
| xmlchars | 2.2.0 | MIT |
| xmlhttprequest-ssl | 2.1.2 | MIT |
| xtend | 4.0.2 | MIT |
| y18n | 5.0.8 | ISC |
| yallist | 3.1.1 | ISC |
| yallist | 4.0.0 | ISC |
| yallist | 5.0.0 | BlueOak-1.0.0 |
| yaml | 2.8.2 | ISC |
| yargs | 16.2.0 | MIT |
| yargs | 17.7.2 | MIT |
| yargs-parser | 20.2.9 | ISC |
| yargs-parser | 21.1.1 | ISC |
| yauzl | 2.10.0 | MIT |
| yn | 3.1.1 | MIT |
| yocto-queue | 0.1.0 | MIT |
| yoctocolors | 2.1.2 | MIT |
| yoctocolors-cjs | 2.1.3 | MIT |
| yoga-layout | 3.2.1 | MIT |
| zip-stream | 6.0.1 | MIT |
| zlibjs | 0.3.1 | MIT |
| zod | 3.25.76 | MIT |
| zod | 4.1.11 | MIT |
| zod-to-json-schema | 3.25.1 | ISC |
| zustand | 4.5.7 | MIT |
| zustand | 5.0.8 | MIT |
| zwitch | 2.0.4 | MIT |

---

## 9. Methodology & Reproducibility

1. **Authorship:** `git log --all --format='%an <%ae>|%h|%s'`.
2. **Direct deps:** parsed every `package.json` in `apps/`, `packages/`,
   `prototypes/`, and root.
3. **Transitive SBOM:** clean `pnpm install --ignore-scripts`, then
   traverse `node_modules/.pnpm/*/node_modules/` reading each
   `package.json`'s `license` field.
4. **Provenance:** `pnpm why <package>` and `pnpm --filter <app> why <package>`.
5. **Copyleft detection:** regex
   `\bGPL\b|\bLGPL\b|\bAGPL\b|\bCDDL\b|\bEPL\b|\bMPL\b|\bSSPL\b|COPYLEFT|OSL|EUPL`
   against the `license` string. This is a pre-filter, not an SPDX parser;
   every matched package is listed by name in §4 and its SPDX expression
   (including `OR` / `AND` composites) manually classified. Upgrading to a
   full SPDX expression parser (e.g. `spdx-expression-parse`) would be
   appropriate if this audit were embedded in CI; for a one-off DD
   artifact it adds no signal.

This report and `THIRD-PARTY-NOTICES.md` are regenerable from the lockfile
and git history — no manual data entry.
