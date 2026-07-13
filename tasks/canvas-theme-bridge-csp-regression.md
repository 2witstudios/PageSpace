# Canvas Theme-Bridge CSP Regression

## Requirements

- Given the in-app Canvas editor renders a page with `injectThemeBridge: true` and a nonce (the dashboard's `srcDoc` iframe case), should stamp the same nonce onto the injected theme-bridge `<script>` so it is not blocked by the inherited outer Content-Security-Policy.
