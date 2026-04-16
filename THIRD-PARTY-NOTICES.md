# Third-Party Notices

PageSpace is proprietary software; see `LICENSE` for terms. It incorporates
open-source components that remain subject to their own licenses. The full
SPDX inventory of all 2,100+ transitive packages is reproduced in
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

1. The full LGPL-3.0 license text is reproduced below.
2. These binaries are downloaded from the upstream package registry at
   install time; their source is available at
   <https://github.com/lovell/sharp-libvips>.
3. Users may replace the pre-compiled `libvips` with a modified build. The
   `sharp` package's `install-from-source` flow supports this; see
   <https://sharp.pixelplumbing.com/install#custom-libvips>.

## MPL-2.0 attribution

The following packages are distributed under MPL-2.0. PageSpace uses them
unmodified. Under MPL-2.0 §3.3 an unmodified use imposes **no obligation** to
disclose PageSpace's own source code. If any of these packages is ever
forked or patched in-tree, the modified files must remain MPL-2.0 and be
made available.

| Package | Role | Shipped in production? |
|---|---|---|
| `@capgo/capacitor-social-login` | Apple/Google sign-in plugin for iOS/Android wrappers | Yes (mobile only) |
| `lightningcss` (+ `lightningcss-linux-x64-gnu`, `lightningcss-linux-x64-musl`) | Build-time CSS compiler used by Tailwind v4's PostCSS plugin | No — build-time only; compiled CSS is not MPL-licensed |
| `axe-core` | Accessibility testing, pulled transitively by `eslint-plugin-jsx-a11y` | No — dev-only (lint-time) |

## Full LGPL-3.0 license text

The complete text of the GNU Lesser General Public License v3.0 applicable
to the `@img/sharp-libvips-*` binaries is reproduced from the upstream at:
<https://www.gnu.org/licenses/lgpl-3.0.txt>

## Full MPL-2.0 license text

The complete text of the Mozilla Public License v2.0 applicable to the
packages listed under "MPL-2.0 attribution" is reproduced from the upstream
at:
<https://www.mozilla.org/en-US/MPL/2.0/>

## How this file is generated

The underlying SBOM is reproducible from `pnpm-lock.yaml` via the script
referenced in §9 of `docs/legal/2026-04-16-oss-compliance-report.md`.

Last reviewed: 2026-04-16.
