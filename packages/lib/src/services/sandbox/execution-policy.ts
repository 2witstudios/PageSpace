export const SANDBOX_EGRESS_ALLOWLIST = Object.freeze([
  // GitHub — git clone, API, releases, LFS, release asset CDN
  'github.com', 'api.github.com', 'raw.githubusercontent.com',
  'objects.githubusercontent.com', 'uploads.github.com', 'codeload.github.com',
  'github-releases.githubusercontent.com', 'release-assets.githubusercontent.com',
  // npm / bun
  'registry.npmjs.org',
  // PyPI
  'pypi.org', 'files.pythonhosted.org',
  // Cargo
  'crates.io', 'static.crates.io', 'index.crates.io',
  // Go modules
  'proxy.golang.org', 'sum.golang.org',
] as const);

export const SANDBOX_TIMEOUT_MS = 120_000;
export const SANDBOX_MAX_OUTPUT_BYTES = 256 * 1024;

// Resource caps set explicitly per sandbox at creation, rather than relying on
// the platform's quota defaults. Modest by design: enough for git clones + a
// package install + a build, sized so a single runaway session can't consume an
// oversized VM. `region` is intentionally omitted so the platform co-locates the
// VM near the app. Mapped to the backing provider's config by the driver.
export const SANDBOX_RESOURCE_CAPS = Object.freeze({
  ramMB: 2048,
  cpus: 2,
  storageGB: 5,
} as const);
