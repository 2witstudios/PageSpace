export const SANDBOX_EGRESS_ALLOWLIST = Object.freeze([
  // GitHub — git clone, API, releases, LFS
  'github.com', 'api.github.com', 'raw.githubusercontent.com',
  'objects.githubusercontent.com', 'uploads.github.com', 'codeload.github.com',
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
