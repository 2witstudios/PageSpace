/**
 * Bearer token prefixes — the single source of truth for the prefixes the
 * auth layer mints and authenticates.
 *
 * This is a dependency-free leaf module so the Edge-runtime middleware can
 * import the prefixes without dragging in the '@/lib/auth' barrel, whose
 * import graph (db client, session service, permissions) only exists in the
 * Node.js runtime. The barrel re-exports from here; nothing else may define
 * these values. A hand-duplicated copy is exactly how a prefix (ps_at_, added
 * for OAuth CLI login) silently fell out of sync in middleware.ts before,
 * undetected because middleware never executed in production at all.
 *
 * MUST stay edge-safe: no imports, no Node built-ins, no side effects.
 */
export const MCP_TOKEN_PREFIX = 'mcp_';
export const SESSION_TOKEN_PREFIX = 'ps_sess_';
export const OAUTH_ACCESS_TOKEN_PREFIX = 'ps_at_';
