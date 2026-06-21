/**
 * Webpack loader: patch `@gridland/web`'s module-local `process` object so its
 * `process.nextTick(...)` call (in the scroll-box sticky-scroll handler) is
 * defined in the browser.
 *
 * Background: @gridland/web's `dist/*.js` defines `var process = { env: ... }`
 * without a `nextTick` member, then calls `process.nextTick(() => ...)`. In a
 * Node runtime `nextTick` would exist on the real `process`; in the browser
 * bundle it resolves to `undefined`, throwing
 * `TypeError: B.nextTick is not a function` (B = the minified local `process`)
 * and crashing the app on any terminal page.
 *
 * This loader injects a `nextTick` implementation onto that object at build
 * time. It matches the object-literal shape gridland ships and is a no-op if
 * the upstream shape changes (so an upstream fix doesn't double-define).
 */

/** @returns {string} */
module.exports = function gridlandProcessNextTickLoader(source) {
  if (this.cacheable) this.cacheable(true);

  // The local `process` object gridland ships. Match the full object literal
  // (`var process = { env: { NODE_ENV: "production" } }`) and replace it with a
  // complete object that also defines `nextTick`. Capture the original
  // `NODE_ENV` value so we preserve upstream behavior exactly rather than
  // hardcoding "production". Only patch when `nextTick` is NOT already present
  // on that literal (so an upstream fix is a no-op).
  const PROCESS_OBJECT_RE = /var\s+process\s*=\s*\{\s*env\s*:\s*\{\s*NODE_ENV\s*:\s*"([^"]*)"\s*\}\s*\}/;

  const match = PROCESS_OBJECT_RE.exec(source);
  if (!match) {
    // Shape changed upstream (e.g. they fixed it or renamed). Don't guess.
    return source;
  }

  // queueMicrotask is the closest browser analog to process.nextTick for a
  // single deferred microtask. Fallback to setTimeout(...,0) for very old
  // environments; both satisfy gridland's "defer this render request" intent.
  const nodeEnv = match[1];
  const patched = source.replace(
    PROCESS_OBJECT_RE,
    'var process = { env: { NODE_ENV: "' + nodeEnv + '" }, ' +
    'nextTick: function(cb) { ' +
    'if (typeof queueMicrotask === "function") { queueMicrotask(function() { cb(); }); } ' +
    'else { setTimeout(function() { cb(); }, 0); } ' +
    '}}',
  );

  return patched;
};
