# Third-Party Notices

PageSpace is proprietary software; see `LICENSE` for terms. It incorporates
open-source components that remain subject to their own licenses. The full
SPDX inventory of all 2,104 transitive packages is in §8 of
`docs/legal/2026-04-16-oss-compliance-report.md`.

This file records formal license elections (for dual-licensed packages) and
the attribution notices required by the non-permissive-family components.

## License elections (dual-licensed packages)

For each package listed below, PageSpace elects the permissive option:

| Package | Available licenses | **Elected** |
|---|---|---|
| `dompurify` | MPL-2.0 **OR** Apache-2.0 | **Apache-2.0** |
| `jszip` | MIT **OR** GPL-3.0-or-later | **MIT** |

These elections remove any copyleft obligation from the respective
dependencies.

## LGPL-3.0-or-later attribution

The following packages are distributed under LGPL-3.0-or-later and are
consumed by PageSpace as **pre-compiled dynamically-loaded native libraries**
used by the `sharp` image-processing package. PageSpace neither modifies nor
statically links these libraries. LGPL-3.0 §4 expressly permits this use by
proprietary software.

- `@img/sharp-libvips-darwin-arm64`
- `@img/sharp-libvips-darwin-x64`
- `@img/sharp-libvips-linux-arm`
- `@img/sharp-libvips-linux-arm64`
- `@img/sharp-libvips-linux-x64`
- `@img/sharp-libvips-linuxmusl-x64`
- `@img/sharp-libvips-linuxmusl-arm64`

**Obligations satisfied:**

1. The complete LGPL-3.0 license text is committed in this repository at
   [`LICENSES/LGPL-3.0.txt`](./LICENSES/LGPL-3.0.txt) and must accompany
   any distribution that bundles these binaries (LGPL-3.0 §4(d)(1), §6).
2. These binaries are downloaded from the upstream package registry at
   install time; their source is available at
   <https://github.com/lovell/sharp-libvips>.
3. Users may replace the pre-compiled `libvips` with a modified build. The
   `sharp` package's `install-from-source` flow supports this; see
   <https://sharp.pixelplumbing.com/install#custom-libvips>.

## MPL-2.0 attribution

The following packages are distributed under MPL-2.0. PageSpace uses them
unmodified. **Obligations under MPL-2.0 §3 apply regardless of
modification:**

- MPL-covered files must retain their existing MPL-2.0 notices and
  attribution (§3.2).
- The source form of the MPL-covered files must be made available to
  recipients under MPL-2.0, either by shipping it alongside the
  distribution or by directing recipients to the upstream source (§3.1
  and §3.2). In PageSpace's case this is satisfied by the npm registry
  and the packages' public source repositories.
- A copy of the MPL-2.0 license text must accompany any distribution.
  It is committed in this repository at
  [`LICENSES/MPL-2.0.txt`](./LICENSES/MPL-2.0.txt).

PageSpace's own proprietary code — the surrounding "Larger Work" — may be
licensed under different terms (§3.3). Unmodified use does **not** require
disclosure of PageSpace's proprietary source.

If any MPL-covered file is ever forked or patched in-tree, the modified
file must remain under MPL-2.0 and its source made available.

| Package | Role | Shipped in production? |
|---|---|---|
| `@capgo/capacitor-social-login` | Apple/Google sign-in plugin for iOS/Android wrappers | Yes (mobile only) |
| `lightningcss` (+ `lightningcss-linux-x64-gnu`, `lightningcss-linux-x64-musl`) | Build-time CSS compiler used by Tailwind v4's PostCSS plugin | No — build-time only; compiled CSS is not MPL-licensed |
| `axe-core` | Accessibility testing, pulled transitively by `eslint-plugin-jsx-a11y` | No — dev-only (lint-time) |

Production-shipped MPL packages (relevant to counsel's review):
`@capgo/capacitor-social-login` and `@img/sharp-libvips-*` (LGPL, above).
`lightningcss` and `axe-core` are build/dev-only and not in any shipped
artifact.

## Full license texts

Committed alongside this file:

- [`LICENSES/LGPL-3.0.txt`](./LICENSES/LGPL-3.0.txt) — full LGPL-3.0 text
  applicable to `@img/sharp-libvips-*`.
- [`LICENSES/MPL-2.0.txt`](./LICENSES/MPL-2.0.txt) — full MPL-2.0 text
  applicable to the MPL-2.0 packages above.

Both files are the canonical SPDX-published texts (source:
<https://github.com/spdx/license-list-data>).

## How this file is generated

The underlying SBOM is reproducible from `pnpm-lock.yaml` via the script
referenced in §9 of `docs/legal/2026-04-16-oss-compliance-report.md`.

Last reviewed: 2026-04-16.
