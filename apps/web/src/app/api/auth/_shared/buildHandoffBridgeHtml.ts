interface BuildHandoffBridgeHtmlParams {
  deepLink: string;
  title: string;
  body: string;
}

const escapeHtml = (input: string): string =>
  input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export function buildHandoffBridgeHtml({
  deepLink,
  title,
  body,
}: BuildHandoffBridgeHtmlParams): string {
  const safeDeepLink = escapeHtml(deepLink);
  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(body);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0; url=${safeDeepLink}">
<title>${safeTitle} — PageSpace</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif;
    background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 50%, #bfdbfe 100%);
    color: #0f172a;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
  }
  .card {
    max-width: 420px;
    width: calc(100% - 48px);
    padding: 32px 28px;
    border-radius: 16px;
    background: rgba(255, 255, 255, 0.85);
    border: 1px solid rgba(148, 163, 184, 0.25);
    box-shadow: 0 24px 60px -20px rgba(15, 23, 42, 0.25);
    text-align: center;
  }
  .check {
    width: 48px;
    height: 48px;
    margin: 0 auto 16px;
    color: #10b981;
  }
  .title { font-size: 18px; font-weight: 600; margin: 0 0 8px; color: #0f172a; }
  .body-text { font-size: 14px; color: #475569; margin: 0 0 20px; line-height: 1.5; }
  .fallback { font-size: 12px; margin-top: 16px; }
  .fallback a { color: #2563eb; text-decoration: none; }
  .fallback a:hover { text-decoration: underline; }
  @media (prefers-color-scheme: dark) {
    body {
      background: linear-gradient(135deg, #020617 0%, #0c1f3d 50%, #0f172a 100%);
      color: #e2e8f0;
    }
    .card { background: rgba(15, 23, 42, 0.7); border-color: rgba(148, 163, 184, 0.18); }
    .title { color: #e2e8f0; }
    .body-text { color: #94a3b8; }
  }
</style>
</head>
<body>
<main class="card">
  <svg class="check" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
    <polyline points="22 4 12 14.01 9 11.01"></polyline>
  </svg>
  <p class="title">${safeTitle}</p>
  <p class="body-text">${safeBody}</p>
  <noscript>
    <p class="fallback">If you are not redirected automatically, <a href="${safeDeepLink}">click here to return to PageSpace</a>.</p>
  </noscript>
</main>
</body>
</html>`;
}
