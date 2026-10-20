// What a Node-only module resolves to in a Turbopack client bundle (see
// CLIENT_EMPTY_NODE_MODULES in next.config.ts), as webpack's
// `resolve.fallback: false` does for builds. CommonJS, so its exports are
// dynamic: a named import (`createClient` from @clickhouse/client) resolves to
// undefined in dead code instead of failing the compile.
module.exports = {};
