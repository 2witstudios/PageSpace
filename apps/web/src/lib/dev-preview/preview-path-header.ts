/**
 * The request header the middleware stamps on a rewritten preview-host
 * request with the browser's ORIGINAL pathname, verbatim.
 *
 * The handler cannot recover that path from `nextUrl` reliably — after a
 * middleware rewrite Next hands it the ORIGINAL pathname (not the mount it
 * was rewritten onto), while a direct or test-built request carries the
 * mount — and it must not guess by shape, because a preview app may serve a
 * path that looks like the mount. Set unconditionally on preview hosts, so a
 * client-sent value never survives; on the app origin the Host guard refuses
 * before the path is read.
 *
 * Lives in web (not `@pagespace/lib`) because only the middleware and the
 * host route read it — and the middleware is an Edge graph of leaf modules;
 * this file imports nothing.
 */
export const DEV_PREVIEW_PATH_HEADER = 'x-dev-preview-path';
